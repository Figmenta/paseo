import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, release } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow, ipcMain, powerMonitor, type WebContents } from "electron";
import log from "electron-log/main";
import { CLAUDE_MODEL_MANIFEST } from "@getpaseo/server/claude-model-manifest";
import { getBundledCliShimPath } from "../integrations/cli-install/paths.js";
import { dismissStartupSplash, isStartupSplashWindow } from "./startup-splash-electron.js";
import {
  CLAUDE_CODE_INSTALL_TARGET,
  CLAUDE_CODE_LATEST_URL,
  claudeCodeInstallerCommand,
  claudeCodeReport,
  claudeCodeShim,
  claudeCodeStatus,
  ensureClaudeCode,
  envValue,
  MIN_CLAUDE_CODE_VERSION,
  parseClaudeCodeVersion,
  parseLatestVersion,
  prependToPath,
  recheckClaudeCode,
  requiredClaudeCodeVersion,
  resolveClaudeCode,
  type ClaudeCodeRecheckOutcome,
  type ClaudeCodeReport,
  type ClaudeCodeStatus,
  type ClaudeCodeVersionRead,
  type Env,
  type InstallerRun,
  type SetupComponent,
  type SetupFailure,
  type SetupState,
} from "./claude-code-setup.js";
import { claudeCodeSetupPageUrl } from "./claude-code-setup-page.js";
import { UPDATE_CHECK_INTERVAL_MS, WAKE_CHECK_MIN_INTERVAL_MS } from "./mandatory-update.js";
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

function computeRequiredClaudeCode(): string {
  try {
    return requiredClaudeCodeVersion(CLAUDE_MODEL_MANIFEST);
  } catch (error) {
    // claude-code-setup.test.ts fails the build first; this only keeps a bad manifest from
    // keeping Orchestra closed.
    log.error("[engine-setup] Claude model manifest unreadable: the floor applies", error);
    return MIN_CLAUDE_CODE_VERSION;
  }
}

/**
 * The Claude Code this build requires: the plugin's floor or the newest minimum of a Claude model
 * in the manifest bundled with it (@getpaseo/server), whichever is higher.
 */
export const REQUIRED_CLAUDE_CODE_VERSION = computeRequiredClaudeCode();

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
 * Empties the engine's bin folder but for `keep`. An entry that cannot go (on Windows, a copy a
 * session still runs from) stays: it is not on any name the engine looks for, and the next
 * write tries again.
 */
function clearShimDir(shimDir: string, keep: string | null): void {
  for (const entry of readdirSync(shimDir)) {
    if (entry === keep) continue;
    try {
      rmSync(path.join(shimDir, entry), { recursive: true, force: true });
    } catch {
      // In use: removed by a later write.
    }
  }
}

/** Makes `dir` exist and hold no `claude`: the setup at launch did not find one to link. */
export function emptyClaudeCodeShimDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    clearShimDir(dir, null);
    return readdirSync(dir).every((entry) => !/^claude(\.exe|\.cmd)?$/i.test(entry));
  } catch (error) {
    log.warn("[engine-setup] the engine's bin folder could not be emptied", {
      dir,
      error: errorText(error),
    });
    return false;
  }
}

/**
 * Removes `file`, or (Windows, a session still running from it) moves it aside so the name is
 * free: a running program can be renamed there, not removed. The aside copy goes at a later write.
 */
function freeName(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch (error) {
    renameSync(file, `${file}.old.${Date.now()}`);
    log.info("[engine-setup] previous Claude Code link in use: moved aside", {
      file,
      error: errorText(error),
    });
  }
}

/**
 * Makes the engine's bin folder hold exactly one `claude`, pointing at `target`. Returns the
 * folder, or null when it cannot be made (the caller then falls back to Claude Code's own folder).
 * Called again while the engine runs (the periodic check): what a running session executes is
 * never changed, only the name new sessions start.
 */
export function writeClaudeCodeShim(
  target: string,
  shimDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const shim = claudeCodeShim(platform, target, shimDir);
  try {
    mkdirSync(shimDir, { recursive: true });
    clearShimDir(shimDir, path.basename(shim.file));
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
      // A hard link stays on the file it was made to: when the installer replaces claude.exe
      // (moving the running one aside), the link still starts the old version until made again.
      if (!sameFile(shim.file, target)) {
        freeName(shim.file);
        linkSync(target, shim.file);
      }
    } else {
      // cmd.exe reads a running batch file again after each command: never rewritten unchanged.
      let current: string | null = null;
      try {
        current = readFileSync(shim.file, "utf8");
      } catch {
        current = null;
      }
      if (current !== shim.content) writeFileSync(shim.file, shim.content);
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
// 1.3.15 (V3): `claude` in the Terminal tab, through Orchestra's CLI
// ---------------------------------------------------------------------------

/** Next to the engine's bin folder: `<userData>/terminal-bin`, Windows `%LOCALAPPDATA%\Orchestra\terminal-bin`. */
export function terminalBinDir(env: Env): string {
  const engineBin = engineBinDir(env);
  return (process.platform === "win32" ? path.win32 : path).join(
    path.dirname(engineBin),
    "terminal-bin",
  );
}

export interface TerminalClaudeShim {
  file: string;
  content: string;
}

/**
 * What terminal-bin holds: `claude` (POSIX shell; on Windows for Git Bash) and, on Windows,
 * `claude.cmd`, both handing every argument to `<Orchestra's CLI> maestro-claude --`, which decides
 * whether this person's `claude` runs on a fleet seat (packages/cli). The daemon puts the folder
 * first on a terminal's PATH only when ORCHESTRA_TERMINAL_BIN is in its environment.
 */
export function terminalClaudeShims(
  platform: NodeJS.Platform,
  cliPath: string,
  dir: string,
): TerminalClaudeShim[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  // Git Bash reads C:/x as C:\x; inside double quotes a backslash, ", $ and ` would be special.
  const shPath = (platform === "win32" ? cliPath.replaceAll("\\", "/") : cliPath).replace(
    /[\\"$`]/g,
    "\\$&",
  );
  const shims: TerminalClaudeShim[] = [
    {
      file: p.join(dir, "claude"),
      content: `#!/bin/sh\nexec "${shPath}" maestro-claude -- "$@"\n`,
    },
  ];
  if (platform === "win32") {
    // `%` would expand inside a batch file: doubled, it is a literal one.
    shims.push({
      file: p.join(dir, "claude.cmd"),
      content: `@"${cliPath.replaceAll("%", "%%")}" maestro-claude -- %*\r\n`,
    });
  }
  return shims;
}

/**
 * Writes terminal-bin for `cliPath` (made again at every launch of the engine; a file already
 * right is left as is, cmd.exe reads a running batch file again). False when it cannot be written.
 */
export function writeTerminalBin(
  dir: string,
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    for (const shim of terminalClaudeShims(platform, cliPath, dir)) {
      let current: string | null = null;
      try {
        current = readFileSync(shim.file, "utf8");
      } catch {
        current = null;
      }
      if (current !== shim.content) writeFileSync(shim.file, shim.content);
      chmodSync(shim.file, 0o755);
    }
    return true;
  } catch (error) {
    log.warn("[terminal] terminal-bin could not be written", { dir, error: errorText(error) });
    return false;
  }
}

/**
 * For the engine Orchestra launches, and only for it: terminal-bin written and named in
 * ORCHESTRA_TERMINAL_BIN, the engine's bin folder named in ORCHESTRA_ENGINE_BIN. Without
 * Orchestra's CLI on disk (a development run) there is no terminal-bin and no variable.
 */
function withTerminalBin(env: Env): Env {
  let cliPath: string | null = null;
  try {
    cliPath = getBundledCliShimPath();
  } catch (error) {
    log.warn("[terminal] Orchestra's CLI not located", { error: errorText(error) });
  }
  const next: Env = { ...env };
  const engineBin = engineClaudeCode?.shimDir ?? null;
  if (engineBin !== null) next.ORCHESTRA_ENGINE_BIN = engineBin;
  if (cliPath === null || !isFile(cliPath)) {
    log.info("[terminal] no Orchestra CLI on disk: terminals use the person's own claude", {
      cliPath,
    });
    return next;
  }
  const dir = terminalBinDir(env);
  if (!writeTerminalBin(dir, cliPath)) return next;
  next.ORCHESTRA_TERMINAL_BIN = dir;
  log.info("[terminal] claude in the Terminal tab goes through Orchestra", { dir, cliPath });
  return next;
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
      (other) => other !== win && !other.isDestroyed() && !isStartupSplashWindow(other),
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
    // It stands in for Orchestra while something installs: the startup splash gives way to it
    // (and is never its parent, a child closes with its parent).
    dismissStartupSplash("engine setup window");
    const parent =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(
        (other) => !other.isDestroyed() && !isStartupSplashWindow(other),
      ) ??
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
let refreshClaudeCatalog: (() => Promise<void>) | null = null;

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

type Prepared =
  | { status: "ready"; env: Env }
  /** `env`: what the engine starts with instead of the app's own environment, if anything. */
  | { status: "failed"; failure: SetupFailure; env?: Env };

/**
 * The `claude` an engine Orchestra launched gives new sessions: its private bin folder (null when
 * that folder could not be made: then nothing here can change it) and the file in it, or the real
 * copy when the folder could not be used. Null: Orchestra did not launch the engine running now.
 */
interface EngineClaudeCode {
  shimDir: string | null;
  copy: string | null;
}

let engineClaudeCode: EngineClaudeCode | null = null;

function claudeCodeResolver(platform: NodeJS.Platform, env: Env) {
  return () =>
    resolveClaudeCode({
      platform,
      env,
      homedir: homedir(),
      exists: isFile,
      readVersion: (file) => readClaudeCodeVersion(file, env),
      minimum: REQUIRED_CLAUDE_CODE_VERSION,
    });
}

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

  const shimDir = engineBinDir(env);
  const claude = await ensureClaudeCode({
    resolve: claudeCodeResolver(platform, env),
    // Below the minimum or missing: the exact newest version when it can be read (no brake below
    // the minimum), else `latest` as in 1.3.14. A copy that meets the minimum is brought to the
    // newest version by the check right after launch, in the background (startClaudeCodeWatch).
    install: async () => {
      const latest = await latestClaudeCodeVersion();
      if (latest !== null) recordLatestAttempt(latest);
      const installer = claudeCodeInstallerCommand(
        platform,
        env,
        latest ?? CLAUDE_CODE_INSTALL_TARGET,
      );
      return runInstaller(installer.command, installer.args, installer.env, signal);
    },
    minimum: REQUIRED_CLAUDE_CODE_VERSION,
    screen,
    log: logSetup,
  });
  if (claude.status === "failed") {
    // The engine starts with the app's own environment, as before, plus the private folder,
    // empty: when the periodic check installs Claude Code later, it links it there and new
    // sessions find it without a restart of the engine.
    const empty = emptyClaudeCodeShimDir(shimDir);
    engineClaudeCode = empty ? { shimDir, copy: null } : null;
    return empty ? { ...claude, env: prependToPath(baseEnv, shimDir, platform) } : claude;
  }
  const { resolution } = claude;
  // Always through the private folder, even when PATH already finds this copy first: the
  // periodic check can then point new sessions at another copy without restarting the engine.
  const binDir = writeClaudeCodeShim(resolution.path, shimDir, platform);
  if (binDir !== null) {
    env = prependToPath(env, binDir, platform);
  } else if (!resolution.firstOnPath) {
    env = prependToPath(env, path.dirname(resolution.path), platform);
  }
  engineClaudeCode = {
    shimDir: binDir,
    copy:
      binDir !== null ? claudeCodeShim(platform, resolution.path, binDir).file : resolution.path,
  };
  publishClaudeCodeStatus(
    claudeCodeStatus(resolution.version, REQUIRED_CLAUDE_CODE_VERSION, new Date()),
  );
  logSetup("the engine will run Claude Code", {
    path: resolution.path,
    version: resolution.version,
    required: REQUIRED_CLAUDE_CODE_VERSION,
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
    if (git.status === "failed") {
      engineClaudeCode = null;
      return git;
    }
    if (git.status === "system" && git.explicit) env = withGitBash(env, git.bashPath, null);
    if (git.status === "bundled") env = withGitBash(env, git.layout.bashPath, git.layout.cmdDir);
  }
  return { status: "ready", env };
}

async function prepare(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  // One installer at a time: a background check that is installing finishes first.
  if (recheckRunning) await recheckRunning;
  ownEngineLaunched = true;
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
    return withTerminalBin(prepared.env) as NodeJS.ProcessEnv;
  }
  setStatus("failed");
  // Settings shows why (V1); a Git Bash failure leaves Claude Code itself as it is.
  if (prepared.failure.component === "claude-code") {
    recordClaudeCodeFailure(prepared.failure.message, prepared.failure.detail);
  }
  logSetup("the engine starts without the setup: Maestro waits for Claude Code", {
    component: prepared.failure.component,
    dismissed: abort.signal.aborted,
  });
  // Closed by the user: not reopened. Otherwise the reason and "Try again" stay on screen.
  if (!abort.signal.aborted) getSetupWindow().show({ phase: "failed", ...prepared.failure });
  // What the page is told: measured once this setup is over, nothing installed (the setup just
  // tried; the next periodic check tries again in the background).
  measureAfterFailure ??= setTimeout(() => {
    measureAfterFailure = null;
    void recheckClaudeCodeNow("setup failed", { measureOnly: true });
  }, 0);
  return withTerminalBin(prepared.env ?? baseEnv) as NodeJS.ProcessEnv;
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
  /** After the periodic check changed the Claude Code new sessions get: the engine reads its
   * Claude model catalog again (it hides models the previous version could not run). */
  refreshClaudeCatalog?: () => Promise<void>;
}): void {
  restartEngine = options.restartEngine;
  onStatusChange = options.onStatusChange ?? null;
  refreshClaudeCatalog = options.refreshClaudeCatalog ?? null;
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
  refreshClaudeCatalog = null;
  engineClaudeCode = null;
  claudeCodeStatusNow = null;
  recheckRunning = null;
  lastRecheckAt = null;
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
  if (measureAfterFailure) clearTimeout(measureAfterFailure);
  measureAfterFailure = null;
  watchStarted = false;
  failureNow = null;
  latestCache = null;
  latestNow = null;
  ownEngineLaunched = false;
}

app.on("before-quit", () => {
  active?.abort();
  background?.abort();
  for (const child of running) killProcessTreeNow(child);
});

// ---------------------------------------------------------------------------
// While Orchestra runs: the periodic check, and window.orchestraDesktop.claudeCode
// ---------------------------------------------------------------------------

/** The main window's preload (preload.ts) listens here and asks here for the current status. */
export const CLAUDE_CODE_STATUS_CHANNEL = "orchestra-desktop:claude-code";
export const CLAUDE_CODE_STATUS_GET_CHANNEL = "orchestra-desktop:claude-code:get";
/** Test knob: a shorter period for the check (the local E2E of 1.3.14 uses it). */
export const CLAUDE_CODE_CHECK_INTERVAL_ENV = "ORCHESTRA_CLAUDE_CODE_CHECK_INTERVAL_MS";

let claudeCodeStatusNow: ClaudeCodeReport | null = null;
let recheckRunning: Promise<void> | null = null;
let lastRecheckAt: number | null = null;
let recheckTimer: NodeJS.Timeout | null = null;
let measureAfterFailure: NodeJS.Timeout | null = null;
let watchStarted = false;
/** The background install running now: aborted at quit, with every process it started. */
let background: AbortController | null = null;
/** prepareEngineEnvironment() ran in this run of the app: the engine running is Orchestra's own. */
let ownEngineLaunched = false;

export function claudeCodeCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLAUDE_CODE_CHECK_INTERVAL_ENV];
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : UPDATE_CHECK_INTERVAL_MS;
}

// --- V1: the last failure that left the machine below the minimum or without Claude Code ---

let failureNow: { message: string; detail: string; at: Date } | null = null;

/** Kept until a status that meets the minimum is published (publishClaudeCodeStatus). */
function recordClaudeCodeFailure(message: string, detail: string): void {
  failureNow = { message, detail, at: new Date() };
}

// --- V2: the newest published Claude Code, and the 6-hour brake ---

const LATEST_TIMEOUT_MS = 5_000;
const LATEST_CACHE_MS = 60 * 60 * 1000;
/** The file the brake lives in, under userData: {"at":"<ISO>","target":"2.1.295"}. */
export const LATEST_ATTEMPT_FILE = "claude-code-latest-attempt.json";

/** The body of CLAUDE_CODE_LATEST_URL; throws on a failed read. Tests hand in their own. */
export type LatestClaudeCodeSource = (signal: AbortSignal) => Promise<string>;

const fetchLatestClaudeCode: LatestClaudeCodeSource = async (signal) => {
  const response = await fetch(CLAUDE_CODE_LATEST_URL, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};

let latestSource: LatestClaudeCodeSource = fetchLatestClaudeCode;
let latestCache: { version: string; readAt: number } | null = null;
/** What the page reads as `latest`: the last read, null when it failed. */
let latestNow: string | null = null;

/** Test seam: where the newest version is read from (null: the real URL). */
export function __setLatestClaudeCodeSource(source: LatestClaudeCodeSource | null): void {
  latestSource = source ?? fetchLatestClaudeCode;
  latestCache = null;
}

/** The newest published version: read at most once an hour, within 5 s; null when it cannot be. */
export async function latestClaudeCodeVersion(): Promise<string | null> {
  if (latestCache !== null && Date.now() - latestCache.readAt < LATEST_CACHE_MS) {
    return latestCache.version;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LATEST_TIMEOUT_MS);
  let version: string | null = null;
  try {
    const body = await Promise.race([
      latestSource(abort.signal),
      new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(new Error("timed out after 5 s")), {
          once: true,
        });
      }),
    ]);
    version = parseLatestVersion(body);
    if (version === null) {
      log.warn("[engine-setup] the newest Claude Code version is unreadable", {
        body: body.slice(0, 100),
      });
    }
  } catch (error) {
    log.warn("[engine-setup] the newest Claude Code version could not be read", {
      error: errorText(error),
    });
  } finally {
    clearTimeout(timer);
  }
  latestNow = version;
  latestCache = version === null ? null : { version, readAt: Date.now() };
  return version;
}

function latestAttemptFile(): string {
  return path.join(app.getPath("userData"), LATEST_ATTEMPT_FILE);
}

/** When the last attempt toward the newest version started; null when none is on record. */
export function lastLatestAttemptAt(): Date | null {
  try {
    const record = JSON.parse(readFileSync(latestAttemptFile(), "utf8")) as { at?: unknown };
    if (typeof record.at !== "string") return null;
    const at = new Date(record.at);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/** Written BEFORE the installer starts: an install that never returns still brakes. */
function recordLatestAttempt(target: string): void {
  const file = latestAttemptFile();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), target }));
  } catch (error) {
    log.warn("[engine-setup] the attempt toward the newest Claude Code was not recorded", {
      file,
      error: errorText(error),
    });
  }
}

// --- What the page reads ---

function publishClaudeCodeStatus(next: ClaudeCodeStatus): void {
  if (next.ok) failureNow = null;
  const report = claudeCodeReport(next, {
    latest: latestNow,
    failure: failureNow,
    platform: process.platform,
    osVersion: release(),
  });
  claudeCodeStatusNow = report;
  lastRecheckAt = Date.now();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(CLAUDE_CODE_STATUS_CHANNEL, report);
  }
}

/**
 * Below the minimum (or without Claude Code) after an attempt: Settings shows why. An attempt
 * toward the newest version that leaves a copy meeting the minimum is the log's business only.
 */
function recordRecheckFailure(outcome: ClaudeCodeRecheckOutcome): void {
  if (outcome.action !== "failed" || outcome.status.ok) return;
  const { version, required } = outcome.status;
  const reason = outcome.reason ?? "unknown reason";
  recordClaudeCodeFailure(
    version === null
      ? `Claude Code could not be installed: ${reason}.`
      : `Claude Code ${version} is older than ${required} and could not be updated: ${reason}.`,
    outcome.detail ?? "",
  );
}

/** The official installer for `target`, in the background: aborted at quit with its children. */
async function installInBackground(
  platform: NodeJS.Platform,
  env: Env,
  target: string,
): Promise<InstallerRun> {
  const installer = claudeCodeInstallerCommand(platform, env, target);
  const abort = new AbortController();
  background = abort;
  try {
    return await runInstaller(installer.command, installer.args, installer.env, abort.signal);
  } finally {
    if (background === abort) background = null;
  }
}

async function runRecheck(reason: string, measureOnly: boolean): Promise<void> {
  const platform = process.platform;
  const env: Env = { ...process.env };
  const engine = engineClaudeCode;
  const manage = !measureOnly && engine !== null && engine.shimDir !== null;
  const latest = await latestClaudeCodeVersion();
  const outcome = await recheckClaudeCode({
    required: REQUIRED_CLAUDE_CODE_VERSION,
    engineCopy: engine?.copy ?? null,
    manage,
    latest,
    lastAttemptAt: lastLatestAttemptAt,
    recordAttempt: recordLatestAttempt,
    readVersion: (file) => readClaudeCodeVersion(file, env),
    resolve: claudeCodeResolver(platform, env),
    install: (target) => installInBackground(platform, env, target),
    repoint: (file) => {
      // An engine launched since this check began has its own link: left alone.
      if (engine === null || engine.shimDir === null || engine !== engineClaudeCode) return false;
      const dir = writeClaudeCodeShim(file, engine.shimDir, platform);
      if (dir === null) return false;
      engine.copy = claudeCodeShim(platform, file, dir).file;
      return true;
    },
    now: () => new Date(),
    log: logSetup,
  });
  recordRecheckFailure(outcome);
  publishClaudeCodeStatus(outcome.status);
  logSetup("Claude Code check", {
    reason,
    action: outcome.action,
    version: outcome.status.version,
    required: outcome.status.required,
    latest,
    ok: outcome.status.ok,
    ...(outcome.path ? { path: outcome.path } : {}),
    ...(outcome.reason ? { why: outcome.reason } : {}),
  });
  if (outcome.action !== "repointed" && outcome.action !== "installed") return;

  // The launch had failed on Claude Code and new sessions now find it: the File menu item and a
  // failure still on screen are out of date.
  if (status === "failed") {
    setStatus("ready");
    const shown = setupWindow?.getState();
    if (shown?.phase === "failed" && shown.component === "claude-code") setupWindow?.close();
  }
  try {
    await refreshClaudeCatalog?.();
    logSetup("the engine read its Claude model catalog again");
  } catch (error) {
    log.warn("[engine-setup] the engine did not read its Claude model catalog again", {
      error: errorText(error),
    });
  }
}

/**
 * One check now, unless one is running (that one is returned) or the setup of an engine launch is
 * (it measures and publishes by itself). Never rejects.
 */
export function recheckClaudeCodeNow(
  reason: string,
  options: { measureOnly?: boolean } = {},
): Promise<void> {
  if (recheckRunning) return recheckRunning;
  if (inFlight) return Promise.resolve();
  lastRecheckAt = Date.now();
  const run = runRecheck(reason, options.measureOnly === true)
    .catch((error) => {
      log.warn("[engine-setup] Claude Code check failed", { reason, error: errorText(error) });
    })
    .finally(() => {
      if (recheckRunning === run) recheckRunning = null;
    });
  recheckRunning = run;
  return run;
}

/**
 * main.ts, before the first Orchestra window: answers the page's preload, then checks Claude Code
 * on the mandatory updater's cadence (every 30 minutes, and on resume, unlock and window focus at
 * most every 5 minutes). When Orchestra launched the engine and its setup found a copy that meets
 * the minimum, the first check runs now and brings it to the newest version in the background
 * (V2: "at the first check"); when Orchestra reused an engine it did not launch, the first check
 * only measures, and terminals keep the person's own `claude` (V3). Returns that first check.
 */
export function startClaudeCodeWatch(): Promise<void> {
  if (watchStarted) return Promise.resolve();
  watchStarted = true;
  ipcMain.on(CLAUDE_CODE_STATUS_GET_CHANNEL, (event) => {
    event.returnValue = claudeCodeStatusNow;
  });
  recheckTimer = setInterval(
    () => void recheckClaudeCodeNow("interval"),
    claudeCodeCheckIntervalMs(),
  );
  const onWake = (reason: string) => {
    if (lastRecheckAt !== null && Date.now() - lastRecheckAt < WAKE_CHECK_MIN_INTERVAL_MS) return;
    void recheckClaudeCodeNow(reason);
  };
  powerMonitor.on("resume", () => onWake("resume"));
  powerMonitor.on("unlock-screen", () => onWake("unlock-screen"));
  app.on("browser-window-focus", () => onWake("focus"));
  if (!ownEngineLaunched) {
    log.info("[terminal] another engine is running: terminals use the person's own claude");
  }
  if (recheckRunning) return recheckRunning;
  if (claudeCodeStatusNow !== null) {
    // The setup just measured: an engine of Orchestra's own with a good copy goes on to the newest.
    if (claudeCodeStatusNow.ok && engineClaudeCode?.shimDir) return recheckClaudeCodeNow("launch");
    return Promise.resolve();
  }
  // Measured only: an install that failed at launch is tried again at the next check, not a second
  // time now, and an engine Orchestra reused is never changed.
  return recheckClaudeCodeNow("launch", { measureOnly: true });
}
