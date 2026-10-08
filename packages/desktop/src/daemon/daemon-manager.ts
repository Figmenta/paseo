import { readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import {
  resolvePaseoHome,
  startDaemonInstance,
  DaemonInstanceError,
  stopDaemonInstance,
  readDaemonInstance,
  isSameDaemonInstance,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
} from "../integrations/cli-install/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import {
  resolveBundledDaemonRuntime,
  resolveBundledServerVersion,
  resolvePaseoAppDaemonRuntime,
  type DaemonLaunchRuntime,
} from "./runtime-paths.js";
import { pickDaemonRuntime } from "../figmenta/daemon-runtime.js";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { shouldRestartDaemonForVersion } from "../figmenta/orchestra.js";
import { describeSandbox } from "../diagnostics/sandbox.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { getDesktopUpdaterDiagnostics } from "../diagnostics/updater.js";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "../integrations/legacy-skill-selection.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
// Figmenta fork: `serverVersion` is the @getpaseo/server version of the runtime this app
// launched — Orchestra's own version (1.x) is not a server version and never compared.
let ownedLaunch: { home: string; instance: DaemonInstance; serverVersion: string } | null = null;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "app_update",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  ownedByDesktop: boolean;
  startedAt: string | null;
  error: string | null;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome(process.env);
}

function logFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_LOG_FILENAME);
}

// Figmenta fork: `desktopManaged: true` in the pid lock only means "a desktop app
// spawned this daemon" — it does not say WHICH one. Orchestra and an installed Paseo
// Desktop share ~/.paseo, so quitting consults `ownedLaunch` (the instance THIS process
// acquired through startDaemonInstance) instead: only that daemon may be stopped on quit.
export function wasDaemonSpawnedByThisApp(): boolean {
  return ownedLaunch !== null;
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  if (!ownedLaunch) return false;
  try {
    const lock = JSON.parse(readFileSync(path.join(ownedLaunch.home, "paseo.pid"), "utf8"));
    return isSameDaemonInstance(lock, ownedLaunch.instance) && isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await stopDesktopDaemon(reason);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  let status: DesktopDaemonState = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error: null,
  };
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();

  try {
    const payload = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      home,
      "--json",
    ])) as Record<string, unknown>;
    return statusFromDaemonProbe(payload, home);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus CLI command failed", { error: errorMessage });
    return {
      serverId: "",
      status: "errored",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      ownedByDesktop: false,
      startedAt: null,
      error: errorMessage,
    };
  }
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

// Figmenta fork: a version mismatch restarts only a daemon THIS app spawned. Upstream
// restarted any `desktopManaged` one, which in Orchestra means a daemon belonging to an
// installed Paseo Desktop sharing ~/.paseo. A foreign daemon is reused as it is. The
// expected version is the server this app launched, not the app's own 1.x version.
function expectedOwnedServerVersion(): string | null {
  return ownedLaunch?.serverVersion ?? null;
}

function shouldRestartForVersion(current: DesktopDaemonStatus): boolean {
  return shouldRestartDaemonForVersion({
    spawnedByThisApp: current.ownedByDesktop,
    desktopManaged: current.desktopManaged,
    expectedVersion: expectedOwnedServerVersion(),
    daemonVersion: current.version,
  });
}

// Figmenta fork: the environment an engine THIS app launches gets — Claude Code found (or
// installed) and first on PATH, Git Bash on Windows (figmenta/claude-code-setup-electron.ts).
// main.ts registers it; it runs only right before a launch of our own, never for a daemon we reuse.
// A setup that fails hands back the app's own environment: the engine always starts.
export type EngineEnvironmentPreparer = (baseEnv: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>;

let engineEnvironmentPreparer: EngineEnvironmentPreparer | null = null;

export function setEngineEnvironmentPreparer(preparer: EngineEnvironmentPreparer | null): void {
  engineEnvironmentPreparer = preparer;
}

async function ownEngineEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (!engineEnvironmentPreparer) return process.env;
  try {
    return await engineEnvironmentPreparer(process.env);
  } catch (error) {
    logDesktopDaemonLifecycle("engine environment not prepared, launching with the app's own", {
      error: error instanceof Error ? error.message : String(error),
    });
    return process.env;
  }
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

export async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());

  const current = await resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  if (current.status === "running" || current.status === "starting") {
    if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        expectedVersion: normalizeVersion(expectedOwnedServerVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDesktopDaemon("version_mismatch");
    } else {
      if (!current.ownedByDesktop) {
        logDesktopDaemonLifecycle("reusing a daemon this app did not spawn", {
          pid: current.pid,
          listen: current.listen,
          daemonVersion: current.version,
          bundledServerVersion: resolveBundledServerVersion(),
        });
      }
      return current;
    }
  }

  // Figmenta fork: nothing is listening, so Orchestra launches one — the newest server on
  // this machine (its own, or an installed Paseo.app's), see figmenta/daemon-runtime.ts.
  const home = getPaseoHome();
  const bundled = resolveBundledDaemonRuntime(getBundledCliShimPath());
  const engineEnv = await ownEngineEnvironment();
  await launchWithBundledFallback(home, bundled, pickOrchestraDaemonRuntime(bundled), engineEnv);
  return resolveDesktopDaemonStatus();
}

/**
 * Launches `picked`; if it is not the bundled runtime and it fails — an exception, or a
 * supervisor that stays alive without ever becoming ready (DAEMON_NOT_READY) — the process
 * this app launched is stopped and the bundled server is started instead. The bundled
 * runtime itself keeps upstream's behaviour (not-ready is left running). Both get `baseEnv`.
 */
export async function launchWithBundledFallback(
  home: string,
  bundled: DaemonLaunchRuntime,
  picked: DaemonLaunchRuntime,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (picked === bundled) {
    await launchDaemonRuntime(home, bundled, baseEnv);
    return;
  }
  const abort = new AbortController();
  let reason: string;
  try {
    const outcome = await launchDaemonRuntime(home, picked, baseEnv, abort.signal);
    if (outcome === "ready") return;
    reason = "not ready in time";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  logDesktopDaemonLifecycle("newer runtime failed to start, falling back to the bundled one", {
    source: picked.source,
    version: picked.version,
    reason,
  });
  await abandonLaunch(home, abort);
  await launchDaemonRuntime(home, bundled, baseEnv);
}

const ABANDON_WAIT_MS = 15_000;

async function stopAbandonedSupervisor(home: string, launched: DaemonInstance): Promise<void> {
  const holdsLock = async () => {
    const current = await readDaemonInstance(home);
    return Boolean(current && isSameDaemonInstance(current, launched));
  };
  try {
    process.kill(launched.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const deadline = Date.now() + ABANDON_WAIT_MS;
  while (Date.now() < deadline && (await holdsLock())) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!(await holdsLock())) return;
  logDesktopDaemonLifecycle("abandoned supervisor still holds the lock, killing it", {
    pid: launched.pid,
  });
  try {
    process.kill(launched.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Stops the supervisor this app just launched (SIGTERM through startDaemonInstance's
 * abort signal, SIGKILL if its lock is still held after 15 s) and forgets it. */
async function abandonLaunch(home: string, abort: AbortController): Promise<void> {
  const launched = ownedLaunch?.home === home ? ownedLaunch.instance : null;
  abort.abort();
  if (launched) await stopAbandonedSupervisor(home, launched);
  ownedLaunch = null;
}

export function pickOrchestraDaemonRuntime(
  bundled: DaemonLaunchRuntime,
  resolvePaseoApp: () => DaemonLaunchRuntime | null = resolvePaseoAppDaemonRuntime,
): DaemonLaunchRuntime {
  let paseoApp: DaemonLaunchRuntime | null = null;
  try {
    paseoApp = resolvePaseoApp();
  } catch (error) {
    logDesktopDaemonLifecycle("installed Paseo.app runtime unreadable, ignored", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const picked = pickDaemonRuntime(bundled, paseoApp ? [paseoApp] : []);
  logDesktopDaemonLifecycle("daemon runtime selected", {
    source: picked.source,
    version: picked.version,
    location: picked.location,
    bundledVersion: bundled.version,
    paseoAppVersion: paseoApp?.version ?? null,
  });
  return picked;
}

async function launchDaemonRuntime(
  home: string,
  runtime: DaemonLaunchRuntime,
  baseEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<"ready" | "not_ready"> {
  const invocation = runtime.createInvocation({
    argvMode: "node-script",
    args: [],
    baseEnv,
  });
  try {
    await startDaemonInstance({
      home,
      timeoutMs: 30_000,
      ...invocation,
      env: { ...invocation.env, PASEO_CLI: runtime.cliPath },
      mode: "managed",
      desktopManaged: true,
      ...(signal ? { signal } : {}),
      onAcquired: (instance) => {
        ownedLaunch = { home, instance, serverVersion: runtime.version };
      },
    });
    return "ready";
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) throw error;
    return "not_ready";
  }
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  confirmedInstance?: { pid: number; startedAt: string },
): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();
  const instance = await readDaemonInstance(home);
  const owned = Boolean(
    instance &&
    ownedLaunch &&
    ownedLaunch.home === home &&
    isSameDaemonInstance(instance, ownedLaunch.instance),
  );
  const explicit =
    reason === "manual_ipc" &&
    confirmedInstance &&
    instance &&
    instance.pid === confirmedInstance.pid &&
    instance.startedAt === confirmedInstance.startedAt;
  if (confirmedInstance && !explicit)
    throw new Error(
      "Daemon changed since confirmation; inspect its current home and PID before stopping it.",
    );
  if (!instance || (!owned && !explicit)) return resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("stopping captured supervisor", { reason, pid: instance.pid, owned });
  await stopDaemonInstance(home, {
    instance,
    timeoutMs: 15_000,
    requestShutdown: async (ready) => {
      await runExternalCliJsonCommand(["daemon", "stop", "--host", ready.listen, "--json"]);
    },
  });
  if (owned) ownedLaunch = null;
  return resolveDesktopDaemonStatus();
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  await runExternalCliJsonCommand(["daemon", "restart", "--home", getPaseoHome(), "--json"]);
  return resolveDesktopDaemonStatus();
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

/**
 * Figmenta fork: asks the running engine to read a provider's model catalog again (after
 * Orchestra updated Claude Code under it: the catalog hides models the previous version could
 * not run). No restart, no running session touched.
 */
export async function refreshDaemonProviderCatalog(provider: string): Promise<void> {
  await runExternalCliJsonCommand([
    "provider",
    "refresh",
    provider,
    "--home",
    getPaseoHome(),
    "--json",
  ]);
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status", "--home", getPaseoHome()]);
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    ...createDesktopSettingsCommandHandlers({ settingsStore: getDesktopSettingsStore() }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) =>
      stopDesktopDaemon(
        parseDesktopDaemonStopReason(args),
        typeof args?.pid === "number" && typeof args.startedAt === "string"
          ? { pid: args.pid, startedAt: args.startedAt }
          : undefined,
      ),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_sandbox_diagnostics: () =>
      describeSandbox({
        disabled: app.commandLine.hasSwitch("no-sandbox"),
        launcherReason: process.env.PASEO_DESKTOP_SANDBOX_REASON,
      }),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_update_diagnostics: () => getDesktopUpdaterDiagnostics(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => await openLocalTransportSession(args),
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    // Figmenta fork: Orchestra updates through its own mandatory updater
    // (figmenta/mandatory-update-electron.ts), not upstream's GitHub feed with channels and
    // rollout. These renderer commands are not reachable from the remote Orchestra page;
    // they answer "nothing to do here" instead of hitting GitHub.
    check_app_update: () => {
      const currentVersion = resolveDesktopAppVersion();
      log.info("[orchestra] check_app_update is handled by the mandatory updater", {
        currentVersion,
      });
      return Promise.resolve({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    },
    install_app_update: () => {
      const currentVersion = resolveDesktopAppVersion();
      log.info("[orchestra] install_app_update is handled by the mandatory updater", {
        currentVersion,
      });
      return Promise.resolve({
        installed: false,
        version: currentVersion,
        message: "Orchestra Desktop installs updates through its own update screen.",
      });
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    read_legacy_skill_selection: () => readLegacySkillSelection(),
    delete_legacy_skill_selection: () => deleteLegacySkillSelection(),
  };
}

// Figmenta fork: probe for the Orchestra shell — did the daemon actually load the plugin
// we seeded? Goes through the same CLI the desktop already uses for daemon status.
export async function listDaemonPlugins(): Promise<unknown> {
  return runExternalCliJsonCommand(["plugin", "ls", "--json"]);
}

export function registerDaemonManager(): void {
  const handlers = createDaemonCommandHandlers();

  ipcMain.handle(
    "paseo:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}
