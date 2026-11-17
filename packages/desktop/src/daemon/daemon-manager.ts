import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  type DaemonLaunchRuntime,
} from "./runtime-paths.js";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import {
  isEngineExecutable,
  isOrchestraExecutable,
  isPaseoExecutable,
  isUnderOrchestraFolder,
  ORCHESTRA_DAEMON_MARKER_FILENAME,
  parseProcessExecutable,
  shouldRestartDaemonForVersion,
} from "../figmenta/orchestra.js";
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
  "plugin_outdated",
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

/** The pid lock (`{ pid, startedAt }`) of the supervisor THIS process launched, if any
 * (contratto-1321 §4.3 rule 0). */
export function ownedLaunchInstance(): { pid: number; startedAt: string } | null {
  if (!ownedLaunch || ownedLaunch.home !== getPaseoHome()) return null;
  return { pid: ownedLaunch.instance.pid, startedAt: ownedLaunch.instance.startedAt };
}

/** `orchestra-daemon.json`: the instance an Orchestra launched last (§4.3 rule 2). */
export function readOrchestraLaunchMarker(
  home: string = getPaseoHome(),
): { pid?: unknown; startedAt?: unknown } | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(home, ORCHESTRA_DAEMON_MARKER_FILENAME), "utf-8"),
    ) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as { pid?: unknown; startedAt?: unknown })
      : null;
  } catch {
    return null;
  }
}

function isOrchestraInstance(
  home: string,
  instance: { pid: unknown; startedAt: unknown } | null,
): boolean {
  if (!instance) return false;
  const owned = ownedLaunch?.home === home ? ownedLaunch.instance : null;
  if (owned && owned.pid === instance.pid && owned.startedAt === instance.startedAt) return true;
  const marker = readOrchestraLaunchMarker(home);
  return Boolean(marker && marker.pid === instance.pid && marker.startedAt === instance.startedAt);
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

function runProbe(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** The executable image of `pid` (not its command line: the supervisor retitles itself). */
export function processExecutable(pid: number): string | null {
  if (process.platform === "darwin") {
    return (
      parseProcessExecutable(
        "lsof",
        runProbe("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]),
      ) ?? parseProcessExecutable("proc", runProbe("ps", ["-o", "ucomm=", "-p", String(pid)]))
    );
  }
  if (process.platform === "linux") {
    try {
      return parseProcessExecutable("proc", readlinkSync(`/proc/${pid}/exe`));
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    return parseProcessExecutable(
      "powershell",
      runProbe("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`]),
    );
  }
  return null;
}

/** Removes `<home>/paseo.pid` only if it still names `instance` (pid AND startedAt). */
async function releaseStaleLock(
  home: string,
  instance: { pid: number; startedAt: string },
): Promise<void> {
  try {
    const lock = JSON.parse(readFileSync(path.join(home, "paseo.pid"), "utf-8")) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (lock?.pid === instance.pid && lock.startedAt === instance.startedAt) {
      unlinkSync(path.join(home, "paseo.pid"));
    }
  } catch {
    // Already gone, or unreadable: nothing to release.
  }
}

/** The process-level reads this module makes, one object so tests can replace them. */
export const engineProcessProbe = {
  executable: processExecutable,
  releaseStaleLock,
};

/** Is the process behind a live lock an engine at all? When not, the lock is stale (its pid
 * was reused): it is released and nothing is signalled. Returns true when released. */
async function releaseIfNotAnEngine(
  home: string,
  instance: { pid: number; startedAt: string },
): Promise<boolean> {
  const executable = engineProcessProbe.executable(instance.pid);
  // Unreadable is not proof of a reused pid (rule 6): leave the lock alone.
  if (executable === null || isEngineExecutable(executable)) return false;
  logDesktopDaemonLifecycle("pid lock names a process that is not an engine, released", {
    pid: instance.pid,
    executable,
  });
  await engineProcessProbe.releaseStaleLock(home, instance);
  return true;
}

/** Why our engine could not be started over what holds the lock (contratto-1321 §4.3). */
export class EngineHolderError extends Error {
  constructor(
    public readonly reason: "port_busy_other" | "foreign_stop_failed",
    message: string,
  ) {
    super(message);
    this.name = "EngineHolderError";
  }
}

let lastForeignStop: number | null = null;

/** When this process last stopped a foreign (Paseo) engine from startDaemon, else null. */
export function lastForeignEngineStopAt(): number | null {
  return lastForeignStop;
}

export function isProcessRunning(pid: number): boolean {
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

let startInFlight: Promise<DesktopDaemonStatus> | null = null;

/** Starts our engine; concurrent calls share the one in flight (its `signal` wins). An
 * aborted `signal` abandons the launch: the supervisor it spawned is stopped, and its
 * lock is not recorded as ours. */
export function startDaemon(signal?: AbortSignal): Promise<DesktopDaemonStatus> {
  if (!startInFlight) {
    startInFlight = startDaemonOnce(signal).finally(() => {
      startInFlight = null;
    });
  }
  return startInFlight;
}

async function startDaemonOnce(signal?: AbortSignal): Promise<DesktopDaemonStatus> {
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
  const live =
    (current.status === "running" || current.status === "starting") &&
    current.pid !== null &&
    current.startedAt !== null
      ? { pid: current.pid, startedAt: current.startedAt }
      : null;
  if (live) {
    if (await releaseIfNotAnEngine(current.home, live)) {
      // A stale lock on a reused pid: released above, nothing signalled; launch below.
    } else if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        expectedVersion: normalizeVersion(expectedOwnedServerVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDesktopDaemon("version_mismatch");
    } else if (current.ownedByDesktop || isOrchestraInstance(current.home, live)) {
      if (!current.ownedByDesktop) {
        logDesktopDaemonLifecycle("reusing the daemon an earlier Orchestra launched", {
          pid: current.pid,
          listen: current.listen,
          daemonVersion: current.version,
          bundledServerVersion: resolveBundledServerVersion(),
        });
      }
      return current;
    } else {
      // Figmenta fork (contratto-1321 §4.3): a live lock that is not ours. A Paseo engine is
      // stopped (rule 5) and ours launched; anything else (another Orchestra, rules 3-4) is
      // left alone and reported as port_busy_other.
      await replaceForeignHolder(live);
    }
  }

  // Figmenta fork: nothing is listening, so Orchestra launches its own bundled server.
  signal?.throwIfAborted();
  const home = getPaseoHome();
  const bundled = resolveBundledDaemonRuntime(getBundledCliShimPath());
  const engineEnv = await ownEngineEnvironment();
  signal?.throwIfAborted();
  await launchWithBundledFallback(
    home,
    bundled,
    pickOrchestraDaemonRuntime(bundled),
    engineEnv,
    signal,
  );
  return resolveDesktopDaemonStatus();
}

async function replaceForeignHolder(live: { pid: number; startedAt: string }): Promise<void> {
  const executable = engineProcessProbe.executable(live.pid);
  if (
    isOrchestraExecutable(executable) ||
    isUnderOrchestraFolder(executable) ||
    !isPaseoExecutable(executable)
  ) {
    logDesktopDaemonLifecycle("not reusing a daemon Orchestra did not launch", {
      pid: live.pid,
      executable,
    });
    throw new EngineHolderError(
      "port_busy_other",
      "The engine lock is held by an instance this app did not launch.",
    );
  }
  logDesktopDaemonLifecycle("a Paseo engine holds the lock, stopping it", {
    pid: live.pid,
    executable,
  });
  const outcome = await stopForeignEngine(live.pid, foreignStopOps(live));
  if (outcome !== "stopped") {
    throw new EngineHolderError("foreign_stop_failed", `Foreign engine not stopped: ${outcome}`);
  }
  lastForeignStop = Date.now();
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
  signal?: AbortSignal,
): Promise<void> {
  if (picked === bundled) {
    await launchDaemonRuntime(home, bundled, baseEnv, signal);
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
  await launchDaemonRuntime(home, bundled, baseEnv, signal);
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

// Figmenta fork (contratto-1321 §4.1): from 1.3.21 our engine ALWAYS runs on the runtime
// bundled in this app, never on an installed Paseo.app's (whose executable is exactly
// Paseo's own, so our engine could not be told apart from a foreign one), and always
// with the environment prepareEngineEnvironment gives it.
export function pickOrchestraDaemonRuntime(bundled: DaemonLaunchRuntime): DaemonLaunchRuntime {
  logDesktopDaemonLifecycle("daemon runtime selected", {
    source: bundled.source,
    version: bundled.version,
    location: bundled.location,
  });
  return bundled;
}

// Figmenta fork: names the instance this Orchestra launched, so a LATER Orchestra process
// can tell it apart from a daemon an installed Paseo.app started (figmenta/orchestra.ts,
// classifyDaemonOwner). A stale file names an instance that no longer holds the lock.
function recordOrchestraLaunch(home: string, instance: DaemonInstance): void {
  try {
    writeFileSync(
      path.join(home, ORCHESTRA_DAEMON_MARKER_FILENAME),
      `${JSON.stringify({ pid: instance.pid, startedAt: instance.startedAt }, null, 2)}\n`,
    );
  } catch (error) {
    // Logged, never thrown: the launch goes on without the marker (§4.1).
    log.warn("[desktop daemon]", "could not record the Orchestra launch marker", {
      pid: instance.pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  let acquired: DaemonInstance | null = null;
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
        // An abandoned launch (stop() during the launch) is never recorded as ours.
        if (signal?.aborted) return;
        acquired = instance;
        ownedLaunch = { home, instance, serverVersion: runtime.version };
        recordOrchestraLaunch(home, instance);
      },
    });
    return "ready";
  } catch (error) {
    if (signal?.aborted && acquired && ownedLaunch?.instance === acquired) ownedLaunch = null;
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
  // Figmenta fork: "plugin_outdated" is Orchestra stopping a daemon an EARLIER Orchestra
  // launched (figmenta/orchestra-daemon-seed.ts), named by the pid lock it just read.
  const explicit =
    (reason === "manual_ipc" || reason === "plugin_outdated") &&
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

// ---------------------------------------------------------------------------
// Figmenta fork (contratto-1321 §4.1, §4.3): stops the engine supervisor uses
// ---------------------------------------------------------------------------

function requestShutdownViaCli(ready: { listen: string }): Promise<void> {
  return runExternalCliJsonCommand(["daemon", "stop", "--host", ready.listen, "--json"]).then(
    () => undefined,
  );
}

function isDaemonReplaced(error: unknown): boolean {
  return error instanceof DaemonInstanceError && error.code === "DAEMON_REPLACED";
}

/**
 * Stops OUR engine (rules 0 and 2) in process, `force` on: the live pid lock must still be
 * `expected` and be this launch or the instance the marker names. A lock whose pid no
 * longer runs an engine (reused pid) is released, nothing signalled. Returns false,
 * stopping nothing, when the lock is not ours or was replaced meanwhile.
 */
export async function forceStopOwnEngine(expected: {
  pid: number;
  startedAt: string;
}): Promise<boolean> {
  const home = getPaseoHome();
  const live = await readDaemonInstance(home);
  if (!live) return true;
  if (live.pid !== expected.pid || live.startedAt !== expected.startedAt) return false;
  if (!isOrchestraInstance(home, live)) return false;
  if (await releaseIfNotAnEngine(home, live)) return true;
  // An executable we cannot read is not proof the pid is still ours (rule 6): only the
  // instance this process launched is stopped without it.
  const launchedHere =
    ownedLaunch?.home === home && isSameDaemonInstance(live, ownedLaunch.instance);
  if (!launchedHere && engineProcessProbe.executable(live.pid) === null) {
    logDesktopDaemonLifecycle("our engine's executable is unreadable, not stopped", {
      pid: live.pid,
    });
    return false;
  }
  logDesktopDaemonLifecycle("force-stopping our engine", { pid: live.pid });
  try {
    await stopDaemonInstance(home, {
      instance: live,
      force: true,
      timeoutMs: 15_000,
      requestShutdown: requestShutdownViaCli,
    });
  } catch (error) {
    if (isDaemonReplaced(error)) return false;
    throw error;
  }
  if (ownedLaunch?.home === home && isSameDaemonInstance(live, ownedLaunch.instance)) {
    ownedLaunch = null;
  }
  return true;
}

/**
 * (a) of the foreign stop, in process: `stopDaemonInstance` on exactly the classified
 * instance, no force, 15 s, shutdown asked through the bundled CLI. "replaced": the lock
 * changed meanwhile — nothing is stopped.
 */
export async function stopInstanceGracefully(instance: {
  pid: number;
  startedAt: string;
}): Promise<"done" | "replaced"> {
  const home = getPaseoHome();
  const live = await readDaemonInstance(home);
  if (!live) return "done";
  if (live.pid !== instance.pid || live.startedAt !== instance.startedAt) return "replaced";
  try {
    await stopDaemonInstance(home, {
      instance: live,
      force: false,
      timeoutMs: 15_000,
      requestShutdown: requestShutdownViaCli,
    });
  } catch (error) {
    if (isDaemonReplaced(error)) return "replaced";
    throw error;
  }
  return "done";
}

function execFileQuiet(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/** Windows: `taskkill /PID <pid> /T /F` — the supervisor and its whole tree. */
export async function killProcessTreeWindows(pid: number): Promise<void> {
  await execFileQuiet("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

/** macOS/Linux: the direct children of `pid` (`pgrep -P`), empty when none or unreadable. */
export async function listChildPids(pid: number): Promise<number[]> {
  try {
    const out = await execFileQuiet("pgrep", ["-P", String(pid)]);
    return out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

export interface ForeignStopOps {
  platform: NodeJS.Platform;
  /** (a) the graceful stop of the classified instance; "replaced" = the lock changed. */
  cliStop(): Promise<"done" | "replaced" | void>;
  isAlive(pid: number): boolean;
  /** The executable image of `pid`, null when unreadable. */
  readExecutable(pid: number): string | null;
  /** Windows `taskkill /PID <pid> /T /F`. */
  killTree(pid: number): Promise<void>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  childPids(pid: number): Promise<number[]>;
  sleep(ms: number): Promise<void>;
  log(message: string, extra?: Record<string, unknown>): void;
}

/** "stopped": S is gone; "not_paseo": S is alive and its executable no longer reads as
 * Paseo, so nothing was signalled; "replaced": the lock changed under the graceful stop,
 * nothing stopped; "still_alive": S survived every step. */
export type ForeignStopOutcome = "stopped" | "not_paseo" | "replaced" | "still_alive";

const FOREIGN_TERM_WAIT_MS = 12_000;
const FOREIGN_POLL_MS = 250;

async function waitForExit(pid: number, ms: number, ops: ForeignStopOps): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += FOREIGN_POLL_MS) {
    if (!ops.isAlive(pid)) return true;
    await ops.sleep(FOREIGN_POLL_MS);
  }
  return !ops.isAlive(pid);
}

/**
 * Stops a FOREIGN engine (§4.3 rule 5) whose supervisor is `pid`: (a) the bundled CLI's
 * `daemon stop`; (b) if S is still alive, its executable is read again — it must still be
 * Paseo, otherwise nothing is signalled — then Windows `taskkill /T /F` on S, macOS/Linux
 * SIGTERM to S, 12 s, then SIGKILL to S and to its children whose executable is still
 * Paseo. Never `Stop-Process` on the supervisor alone. Freeing the port, (c) and (d), is
 * the supervisor's.
 */
export async function stopForeignEngine(
  pid: number,
  ops: ForeignStopOps,
): Promise<ForeignStopOutcome> {
  try {
    if ((await ops.cliStop()) === "replaced") {
      ops.log("foreign engine: the lock changed during the stop, nothing stopped", { pid });
      return "replaced";
    }
  } catch (error) {
    ops.log("foreign engine: daemon stop failed", {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!ops.isAlive(pid)) return "stopped";

  const executable = ops.readExecutable(pid);
  if (!isPaseoExecutable(executable)) {
    ops.log("foreign engine: executable no longer Paseo, not signalled", { pid, executable });
    return "not_paseo";
  }

  if (ops.platform === "win32") {
    try {
      await ops.killTree(pid);
    } catch (error) {
      ops.log("foreign engine: taskkill failed", {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return (await waitForExit(pid, FOREIGN_POLL_MS * 4, ops)) ? "stopped" : "still_alive";
  }

  const children = await ops.childPids(pid);
  try {
    ops.signal(pid, "SIGTERM");
  } catch {
    // Gone in the meantime.
  }
  if (await waitForExit(pid, FOREIGN_TERM_WAIT_MS, ops)) return "stopped";

  if (!isPaseoExecutable(ops.readExecutable(pid))) {
    ops.log("foreign engine: executable changed before SIGKILL, not signalled", { pid });
    return "not_paseo";
  }
  for (const target of [pid, ...children]) {
    if (target !== pid && !isPaseoExecutable(ops.readExecutable(target))) continue;
    try {
      ops.signal(target, "SIGKILL");
    } catch {
      // Gone in the meantime.
    }
  }
  return (await waitForExit(pid, FOREIGN_POLL_MS * 4, ops)) ? "stopped" : "still_alive";
}

/** The real process edges of the foreign stop, for the classified instance. */
export function foreignStopOps(instance: { pid: number; startedAt: string }): ForeignStopOps {
  return {
    platform: process.platform,
    cliStop: () => stopInstanceGracefully(instance),
    isAlive: isProcessRunning,
    readExecutable: (pid) => engineProcessProbe.executable(pid),
    killTree: killProcessTreeWindows,
    signal: (target, signal) => {
      process.kill(target, signal);
    },
    childPids: listChildPids,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message, extra) => logDesktopDaemonLifecycle(message, extra),
  };
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
