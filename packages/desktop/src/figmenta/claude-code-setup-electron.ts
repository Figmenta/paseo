import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import log from "electron-log/main";
import {
  claudeCodeInstallerCommand,
  claudeCodeShim,
  ensureClaudeCode,
  envValue,
  parseClaudeCodeVersion,
  prependToPath,
  resolveClaudeCode,
  type ClaudeCodeVersionRead,
  type Env,
  type InstallerRun,
  type SetupComponent,
  type SetupFailure,
  type SetupState,
} from "./claude-code-setup.js";
import { claudeCodeSetupPageUrl } from "./claude-code-setup-page.js";
import {
  bundledGitLayout,
  ensureGitBash,
  portableGitExtractArgs,
  resolveSystemGitBash,
  withGitBash,
  type BundledGitLayout,
} from "./git-bash-setup.js";

// Figmenta fork: the Electron side of claude-code-setup.ts and git-bash-setup.ts.
// daemon-manager.ts calls prepareEngineEnvironment() right before launching an engine of its own
// and launches it with the environment returned. A window appears only when something has to be
// installed; nothing here runs for a daemon Orchestra reuses.
//
// A setup that does not succeed never keeps Orchestra closed (decision A1, 2026-09-29): the engine
// starts with the app's own environment, as it did before this setup existed, and Orchestra opens;
// only Maestro waits ("Provider 'claude' is not available") until Claude Code is set up. The setup
// window then stays in front of Orchestra with the reason and "Try again"; closing it is "not now"
// and never quits. "Try again" is on that window and, once it is closed, in the File menu ("Set Up
// Claude Code…"); every launch of Orchestra tries again by itself too. A retry that succeeds
// restarts the engine this app launched, so it picks the new environment up.

const VERSION_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Test knob: a shorter limit for the installer and the Git unpack (the Windows E2E uses it). */
export const SETUP_TIMEOUT_ENV = "ORCHESTRA_ENGINE_SETUP_TIMEOUT_MS";
const OUTPUT_LIMIT = 64 * 1024;
/** After SIGTERM to an installer's process group, how long before SIGKILL. */
const TERM_GRACE_MS = 3_000;
/** After a kill, how long to wait for the process to be reported gone before giving up on it. */
const KILL_WAIT_MS = 15_000;
/** After the process exits, how long its pipes may take to drain (a leftover child can hold them). */
const DRAIN_MS = 1_000;

type SetupViewState = SetupState | { phase: "starting"; restart: boolean };

function logSetup(message: string, details?: Record<string, unknown>): void {
  log.info(`[engine-setup] ${message}`, details ?? {});
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function installTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SETUP_TIMEOUT_ENV];
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : INSTALL_TIMEOUT_MS;
}

function describeLimit(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
}

// ---------------------------------------------------------------------------
// Running an installer: a time limit that holds, and no process left behind
// ---------------------------------------------------------------------------

/** Every installer or version read still running: killed, with its children, when the app quits. */
const running = new Set<ChildProcess>();

function taskkillPath(): string {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Stops `child` and every process it started. POSIX: the child leads its own process group
 * (spawned detached), so the whole group gets SIGTERM, then SIGKILL if anything is left after a
 * grace period. Windows: `taskkill /T /F`, which walks the tree from the child; `child.kill()` if
 * taskkill itself cannot run.
 */
export async function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform !== "win32") {
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + TERM_GRACE_MS;
    while (groupAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    return;
  }
  await new Promise<void>((resolve) => {
    execFile(
      taskkillPath(),
      ["/T", "/F", "/PID", String(pid)],
      { windowsHide: true, timeout: KILL_WAIT_MS },
      (error) => {
        if (error) {
          log.warn("[engine-setup] taskkill failed", { pid, error: error.message });
          child.kill();
        }
        resolve();
      },
    );
  });
}

/** At quit there is no time to wait: SIGKILL to the group, or a synchronous taskkill. */
function killProcessTreeNow(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    signalGroup(pid, "SIGKILL");
    return;
  }
  spawnSync(taskkillPath(), ["/T", "/F", "/PID", String(pid)], {
    windowsHide: true,
    timeout: 5_000,
  });
}

export interface ProcessRun extends InstallerRun {
  /** Stopped because `signal` was aborted (the user closed the setup window). */
  cancelled: boolean;
  /** It never started: not found, not executable, wrong architecture. */
  spawnFailed: boolean;
}

export interface RunOptions {
  env: Env;
  timeoutMs: number;
  /** Stops the run, with every process it started, when aborted. */
  signal?: AbortSignal;
  /** The arguments are already quoted for the Windows command line (the Git self-extractor). */
  verbatim?: boolean;
  /** Through the shell: a Windows .cmd only runs that way. */
  shell?: boolean;
}

type Exit = { code: number | null } | { error: Error } | "gave-up";

/** What it wrote just before exiting is still in the pipes: a moment for them, then let go. */
async function releasePipes(child: ChildProcess): Promise<void> {
  const drained = Promise.all(
    [child.stdout, child.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (!stream || stream.destroyed || stream.readableEnded) resolve();
          else stream.once("close", () => resolve());
        }),
    ),
  );
  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function spawnSetupProcess(command: string, args: string[], options: RunOptions): ChildProcess {
  return spawn(command, args, {
    env: options.env as NodeJS.ProcessEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: its own process group, so a time-out can kill everything it started.
    detached: process.platform !== "win32",
    shell: options.shell ?? false,
    ...(options.verbatim ? { windowsVerbatimArguments: true, argv0: `"${command}"` } : {}),
  });
}

/**
 * Waits for `child` to exit, killing its tree past `timeoutMs` or on abort. Resolves on EXIT, not
 * on its pipes closing: a child it leaves behind can hold them open for good.
 */
async function awaitExit(
  child: ChildProcess,
  options: RunOptions,
): Promise<{ exit: Exit; timedOut: boolean; cancelled: boolean }> {
  let timedOut = false;
  let cancelled = false;
  let killing: Promise<void> | null = null;
  let giveUpTimer: NodeJS.Timeout | null = null;
  let giveUp: () => void = () => {};
  const gaveUp = new Promise<"gave-up">((resolve) => {
    giveUp = () => resolve("gave-up");
  });
  const stop = () => {
    if (killing) return;
    killing = killProcessTree(child);
    giveUpTimer = setTimeout(giveUp, KILL_WAIT_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", (error) => resolve({ error }));
  });
  const exit = await Promise.race([exited, gaveUp]);
  clearTimeout(timer);
  if (giveUpTimer) clearTimeout(giveUpTimer);
  options.signal?.removeEventListener("abort", onAbort);
  if (killing) await killing;
  return { exit, timedOut, cancelled };
}

/**
 * Runs a command to its end, keeping the tail of what it says; never throws. Past `timeoutMs`, or
 * on abort, the whole process tree is killed.
 */
export async function runProcess(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<ProcessRun> {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };
  let child: ChildProcess;
  try {
    child = spawnSetupProcess(command, args, options);
  } catch (error) {
    return { ok: false, output: errorText(error), cancelled: false, spawnFailed: true };
  }
  running.add(child);
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const { exit, timedOut, cancelled } = await awaitExit(child, options);
  await releasePipes(child);
  running.delete(child);

  const failedToRun = exit !== "gave-up" && "error" in exit;
  if (failedToRun) append(`\n${exit.error.message}`);
  if (exit === "gave-up") append("\nIt could not be stopped.");
  if (timedOut) append(`\nStopped: it did not finish within ${describeLimit(options.timeoutMs)}.`);
  if (cancelled) append("\nStopped: the setup window was closed.");
  const exitedZero = exit !== "gave-up" && "code" in exit && exit.code === 0;
  return {
    ok: exitedZero && !timedOut && !cancelled,
    output,
    timedOut,
    cancelled,
    spawnFailed: failedToRun && child.pid === undefined,
  };
}

async function runInstaller(
  command: string,
  args: string[],
  env: Env,
  signal: AbortSignal,
  verbatim = false,
): Promise<InstallerRun> {
  logSetup("running", { command, args });
  const result = await runProcess(command, args, {
    env,
    timeoutMs: installTimeoutMs(),
    signal,
    verbatim,
  });
  logSetup("finished", {
    command,
    ok: result.ok,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    output: result.output.slice(-4000),
  });
  return result;
}

/** `claude --version`: slow or unreadable is "unknown" (used as is), not starting is "broken". */
async function readClaudeCodeVersion(file: string, env: Env): Promise<ClaudeCodeVersionRead> {
  // A .cmd shim (npm) only runs through cmd.exe, and the shell does not quote for us.
  const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const result = await runProcess(script ? `"${file}"` : file, ["--version"], {
    env,
    timeoutMs: VERSION_TIMEOUT_MS,
    shell: script,
  });
  if (result.spawnFailed) {
    log.warn("[engine-setup] Claude Code does not start", { file, output: result.output });
    return "broken";
  }
  const version = parseClaudeCodeVersion(result.output);
  if (version !== null) return version;
  log.warn("[engine-setup] Claude Code version unknown: used as is", {
    file,
    timedOut: result.timedOut,
    output: result.output.slice(0, 300),
  });
  return "unknown";
}

// ---------------------------------------------------------------------------
// The engine's private bin folder: `claude`, and nothing else
// ---------------------------------------------------------------------------

function engineBinDir(env: Env): string {
  if (process.platform === "win32") {
    // Local, not Roaming: a hard link to a 200 MB claude.exe has no business in a roaming profile.
    const localAppData = envValue(env, "LOCALAPPDATA", "win32");
    if (localAppData) return path.win32.join(localAppData, "Orchestra", "engine-bin");
  }
  return path.join(app.getPath("userData"), "engine-bin");
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/**
 * Makes the engine's bin folder hold exactly one `claude`, pointing at `target`. Returns the
 * folder, or null when it cannot be made (the caller then falls back to Claude Code's own folder).
 */
export function writeClaudeCodeShim(
  target: string,
  shimDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const shim = claudeCodeShim(platform, target, shimDir);
  try {
    mkdirSync(shimDir, { recursive: true });
    for (const entry of readdirSync(shimDir)) {
      if (entry !== path.basename(shim.file)) {
        rmSync(path.join(shimDir, entry), { recursive: true, force: true });
      }
    }
    if (shim.kind === "symlink") {
      let current: string | null = null;
      try {
        current = readlinkSync(shim.file);
      } catch {
        current = null;
      }
      if (current !== target) {
        rmSync(shim.file, { force: true });
        symlinkSync(target, shim.file);
      }
    } else if (shim.kind === "hardlink") {
      if (!sameFile(shim.file, target)) {
        // Fails while an engine still runs the old link: then the caller uses the real folder.
        rmSync(shim.file, { force: true });
        linkSync(target, shim.file);
      }
    } else {
      writeFileSync(shim.file, shim.content);
    }
    return shimDir;
  } catch (error) {
    log.warn("[engine-setup] no private bin folder for Claude Code", {
      shimDir,
      target,
      kind: shim.kind,
      error: errorText(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestra's own PortableGit (Windows)
// ---------------------------------------------------------------------------

/** scripts/figmenta-portable-git.js writes resources/git/portable-git.json next to the archive. */
function bundledGit(env: Env): BundledGitLayout | null {
  if (process.platform !== "win32" || !app.isPackaged) return null;
  const localAppData = envValue(env, "LOCALAPPDATA", "win32");
  if (!localAppData) return null;
  const gitDir = path.join(process.resourcesPath, "git");
  try {
    const manifest = JSON.parse(readFileSync(path.join(gitDir, "portable-git.json"), "utf8")) as {
      file?: unknown;
      sha256?: unknown;
    };
    if (typeof manifest.file !== "string" || typeof manifest.sha256 !== "string") return null;
    const archive = path.join(gitDir, manifest.file);
    return isFile(archive) ? bundledGitLayout(archive, manifest.sha256, localAppData) : null;
  } catch (error) {
    log.warn("[engine-setup] no bundled Git manifest", { error: errorText(error) });
    return null;
  }
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Checks the archive against the SHA-256 the build pinned, unpacks it into a clean folder, marks
 * it ready, then drops the copies of older builds.
 */
export async function unpackPortableGit(
  layout: BundledGitLayout,
  env: Env,
  signal: AbortSignal,
): Promise<InstallerRun> {
  let actual: string;
  try {
    actual = await sha256OfFile(layout.archive);
  } catch (error) {
    return { ok: false, output: errorText(error) };
  }
  if (actual !== layout.sha256) {
    return {
      ok: false,
      output: `${layout.archive} has SHA-256 ${actual}, expected ${layout.sha256}: not unpacked.`,
      message: "Orchestra's copy of Git Bash is damaged and was not used. Reinstall Orchestra.",
    };
  }
  try {
    rmSync(layout.dir, { recursive: true, force: true });
    mkdirSync(path.dirname(layout.dir), { recursive: true });
  } catch (error) {
    return { ok: false, output: errorText(error) };
  }
  const result = await runInstaller(
    layout.archive,
    portableGitExtractArgs(layout.dir),
    env,
    signal,
    true,
  );
  if (!result.ok) return result;
  if (!isFile(layout.bashPath)) {
    return {
      ok: false,
      output: `${result.output}\n${layout.bashPath} is missing after unpacking.`,
    };
  }
  try {
    writeFileSync(layout.marker, `${new Date().toISOString()}\n`);
  } catch (error) {
    return { ok: false, output: `${result.output}\n${errorText(error)}` };
  }
  const parent = path.dirname(layout.dir);
  for (const entry of readdirSync(parent)) {
    if (entry === path.basename(layout.dir)) continue;
    try {
      rmSync(path.join(parent, entry), { recursive: true, force: true });
    } catch {
      // In use by an engine still running on it: the next unpack tries again.
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The setup window
// ---------------------------------------------------------------------------

/**
 * The small window that stands in for Orchestra while something is installed, and says so when it
 * could not be. Closing it is the user saying "not now": what is running stops, Orchestra goes on.
 */
class SetupWindow {
  private win: BrowserWindow | null = null;
  private state: SetupViewState | null = null;
  private closingOnPurpose = false;

  constructor(private readonly onDismiss: () => void) {}

  isOpen(): boolean {
    return this.win !== null;
  }

  getState(): SetupViewState | null {
    return this.state;
  }

  show(state: SetupViewState): void {
    this.state = state;
    if (!this.win) {
      this.open();
      return;
    }
    this.send();
  }

  /** Brings it to the front and keeps it above Orchestra's window, as a dialog of it. */
  raise(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const parent = BrowserWindow.getAllWindows().find(
      (other) => other !== win && !other.isDestroyed(),
    );
    if (parent) win.setParentWindow(parent);
    win.show();
    win.focus();
  }

  close(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.closingOnPurpose = true;
    win.close();
  }

  isSetupWindow(contents: WebContents): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.webContents === contents;
  }

  private send(): void {
    const win = this.win;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("orchestra-setup:state", this.state);
    }
  }

  private open(): void {
    const parent =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((other) => !other.isDestroyed()) ??
      null;
    const win = new BrowserWindow({
      title: "Orchestra",
      width: 480,
      height: 400,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: "#08090B",
      ...(parent ? { parent } : {}),
      webPreferences: {
        preload: path.join(__dirname, "claude-code-setup-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.once("ready-to-show", () => win.show());
    win.webContents.once("did-finish-load", () => this.send());
    win.once("closed", () => {
      const onPurpose = this.closingOnPurpose;
      this.win = null;
      this.closingOnPurpose = false;
      if (onPurpose) return;
      logSetup("setup window closed by the user: Orchestra goes on without it");
      this.onDismiss();
    });
    this.win = win;
    void win.loadURL(claudeCodeSetupPageUrl());
  }
}

// ---------------------------------------------------------------------------
// The engine's environment, and "Try again"
// ---------------------------------------------------------------------------

export type EngineSetupStatus = "unknown" | "ready" | "failed";

let setupWindow: SetupWindow | null = null;
let inFlight: Promise<NodeJS.ProcessEnv> | null = null;
/** The attempt running now: aborted when the user closes the setup window. */
let active: AbortController | null = null;
let status: EngineSetupStatus = "unknown";
/** Per component: a second attempt at the same one reads "Trying again". */
let installAttempts: Record<SetupComponent, number> = { "claude-code": 0, "git-bash": 0 };
let retrying = false;
let restartEngine: (() => Promise<void>) | null = null;
let onStatusChange: (() => void) | null = null;

let ipcRegistered = false;

function getSetupWindow(): SetupWindow {
  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.handle("orchestra-setup:get-state", (event) =>
      setupWindow?.isSetupWindow(event.sender) ? setupWindow.getState() : null,
    );
    ipcMain.on("orchestra-setup:retry", (event) => {
      if (setupWindow?.isSetupWindow(event.sender)) void retryEngineSetup();
    });
  }
  setupWindow ??= new SetupWindow(() => active?.abort());
  return setupWindow;
}

function setStatus(next: EngineSetupStatus): void {
  if (status === next) return;
  status = next;
  onStatusChange?.();
}

type Prepared = { status: "ready"; env: Env } | { status: "failed"; failure: SetupFailure };

async function prepareOnce(baseEnv: Env, signal: AbortSignal): Promise<Prepared> {
  const platform = process.platform;
  let env: Env = { ...baseEnv };
  // Attempts count across this run of the app, per component: a second one reads "Trying again".
  const screen = {
    show: (state: SetupState) => {
      if (signal.aborted) return;
      if (state.phase !== "installing") {
        getSetupWindow().show(state);
        return;
      }
      installAttempts[state.component] += 1;
      getSetupWindow().show({ ...state, attempt: installAttempts[state.component] });
    },
  };

  const claude = await ensureClaudeCode({
    resolve: () =>
      resolveClaudeCode({
        platform,
        env,
        homedir: homedir(),
        exists: isFile,
        readVersion: (file) => readClaudeCodeVersion(file, env),
      }),
    install: () => {
      const installer = claudeCodeInstallerCommand(platform, env);
      return runInstaller(installer.command, installer.args, installer.env, signal);
    },
    screen,
    log: logSetup,
  });
  if (claude.status === "failed") return claude;
  const { resolution } = claude;
  let binDir: string | null = null;
  if (!resolution.firstOnPath) {
    binDir = writeClaudeCodeShim(resolution.path, engineBinDir(env), platform);
    env = prependToPath(env, binDir ?? path.dirname(resolution.path), platform);
  }
  logSetup("the engine will run Claude Code", {
    path: resolution.path,
    version: resolution.version,
    firstOnPath: resolution.firstOnPath,
    binDir,
    installed: claude.installed,
  });

  if (platform === "win32") {
    const base = env;
    const git = await ensureGitBash({
      resolveSystem: () => resolveSystemGitBash({ env: base, exists: isFile }),
      bundled: () => bundledGit(base),
      exists: isFile,
      unpack: (layout) => unpackPortableGit(layout, base, signal),
      screen,
      log: logSetup,
    });
    logSetup("Git Bash for Claude Code", {
      status: git.status,
      ...(git.status === "system" ? { bashPath: git.bashPath, explicit: git.explicit } : {}),
      ...(git.status === "bundled"
        ? { bashPath: git.layout.bashPath, unpacked: git.unpacked }
        : {}),
    });
    // Claude Code without Git Bash runs the plugin's hooks through PowerShell, where they fail
    // OPEN: the engine rather goes without the Claude Code this setup found.
    if (git.status === "failed") return git;
    if (git.status === "system" && git.explicit) env = withGitBash(env, git.bashPath, null);
    if (git.status === "bundled") env = withGitBash(env, git.layout.bashPath, git.layout.cmdDir);
  }
  return { status: "ready", env };
}

async function prepare(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const abort = new AbortController();
  active = abort;
  let prepared: Prepared;
  try {
    prepared = await prepareOnce(baseEnv, abort.signal);
  } catch (error) {
    prepared = {
      status: "failed",
      failure: {
        component: "claude-code",
        message: "Orchestra could not set up Claude Code.",
        detail: errorText(error),
      },
    };
  } finally {
    if (active === abort) active = null;
  }
  if (prepared.status === "ready") {
    setStatus("ready");
    if (setupWindow?.isOpen()) setupWindow.show({ phase: "starting", restart: retrying });
    return prepared.env as NodeJS.ProcessEnv;
  }
  setStatus("failed");
  logSetup("the engine starts without the setup: Maestro waits for Claude Code", {
    component: prepared.failure.component,
    dismissed: abort.signal.aborted,
  });
  // Closed by the user: not reopened. Otherwise the reason and "Try again" stay on screen.
  if (!abort.signal.aborted) getSetupWindow().show({ phase: "failed", ...prepared.failure });
  return baseEnv;
}

/**
 * The environment for an engine Orchestra launches itself: Claude Code found (installed first when
 * it has to be) and first on PATH, and on Windows a Git Bash it will use. When that cannot be done
 * — the install fails or times out, Git cannot be unpacked, the user closes the setup window — the
 * app's own environment, unchanged: the engine starts as it did before this setup existed. Never
 * rejects. One preparation at a time: concurrent launches share it.
 */
export function prepareEngineEnvironment(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  inFlight ??= prepare(baseEnv).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * "Try again", from the setup window or the File menu: one more attempt behind the setup window;
 * when it succeeds, the engine this app launched is restarted so it runs with Claude Code.
 */
export async function retryEngineSetup(): Promise<void> {
  if (retrying || inFlight) {
    setupWindow?.raise();
    return;
  }
  retrying = true;
  try {
    await prepareEngineEnvironment(process.env);
    if (status !== "ready") {
      setupWindow?.raise();
      return;
    }
    getSetupWindow().show({ phase: "starting", restart: true });
    try {
      await restartEngine?.();
      logSetup("engine restarted after the setup");
      setupWindow?.close();
    } catch (error) {
      log.error("[engine-setup] engine restart after the setup failed", error);
      getSetupWindow().show({
        phase: "failed",
        component: "claude-code",
        message:
          "Claude Code is ready, but the engine did not restart. Quit Orchestra and open it again.",
        detail: errorText(error),
      });
    }
  } finally {
    retrying = false;
  }
}

/** For the File menu: "Set Up Claude Code…" is offered while the last setup did not succeed. */
export function engineSetupStatus(): EngineSetupStatus {
  return status;
}

/**
 * main.ts: how to restart the engine after a retry succeeds, and what to refresh (the menu) when
 * the setup status changes.
 */
export function registerEngineSetup(options: {
  restartEngine: () => Promise<void>;
  onStatusChange?: () => void;
}): void {
  restartEngine = options.restartEngine;
  onStatusChange = options.onStatusChange ?? null;
}

/**
 * Called once the Orchestra window exists. A setup that succeeded is done: its window goes. One
 * that failed keeps its window in front of Orchestra, with the reason and "Try again".
 */
export function finishEngineSetup(): void {
  if (!setupWindow?.isOpen()) return;
  if (setupWindow.getState()?.phase === "failed") setupWindow.raise();
  else if (!inFlight && !retrying) setupWindow.close();
}

/** Test seam: a fresh app run. */
export function __resetEngineSetup(): void {
  setupWindow?.close();
  setupWindow = null;
  inFlight = null;
  active = null;
  status = "unknown";
  installAttempts = { "claude-code": 0, "git-bash": 0 };
  retrying = false;
  restartEngine = null;
  onStatusChange = null;
}

app.on("before-quit", () => {
  active?.abort();
  for (const child of running) killProcessTreeNow(child);
});
