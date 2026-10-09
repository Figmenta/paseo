// Figmenta fork: Claude Code for the engine Orchestra starts itself.
//
// Paseo's Claude provider looks for `claude` on the daemon's PATH and nowhere else. On a clean
// Windows the official installer puts it in %USERPROFILE%\.local\bin and only warns that the
// folder is not on PATH: on 2026-09-29 (Windows 11, Claude Code 2.1.284) the engine answered
// "Provider 'claude' is not available" until Windows was restarted. So, right before launching
// ITS OWN engine, Orchestra finds Claude Code on PATH or where the installers put it, installs it
// with the official installer when it is missing or older than the plugin accepts, and hands the
// engine a PATH that starts with a private folder of the app holding only a link to that `claude`
// (claudeCodeShim): the folder Claude Code lives in may hold other tools, and they must not shadow
// the user's. A daemon Orchestra did not start is never touched: daemon-manager.ts asks for this
// environment only for a launch of its own. A setup that fails leaves the engine as it was: it
// starts anyway, Orchestra opens, only Maestro waits for Claude Code (claude-code-setup-electron.ts).
//
// Pure: the file system, the version read, the installer run and the screen are handed in.

import path from "node:path";
import { compareVersions } from "./semver.js";

/**
 * The floor: the oldest Claude Code the figmenta-sessions plugin runs fleet sessions on (its
 * claude-version.ts). What Orchestra asks of the machine is requiredClaudeCodeVersion(): this
 * floor, or the newest minimum a bundled Claude model needs, whichever is higher.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.283";

/** What requiredClaudeCodeVersion() reads from each entry of the server's Claude model manifest. */
export interface ClaudeModelMinimum {
  id: string;
  minimumClaudeCodeVersion?: string;
}

/**
 * The Claude Code this build of Orchestra needs: the highest of the floor and of every
 * `minimumClaudeCodeVersion` in the Claude model manifest bundled with it (the daemon hides a
 * model whose minimum is above the Claude Code it finds, so a lower copy means a model the user
 * is allowed and cannot pick). Throws on a minimum that is not x.y.z: a typo in the manifest
 * must fail the build's tests, not lower the requirement in silence.
 */
export function requiredClaudeCodeVersion(
  manifest: readonly ClaudeModelMinimum[],
  floor: string = MIN_CLAUDE_CODE_VERSION,
): string {
  let required = floor;
  for (const model of manifest) {
    const minimum = model.minimumClaudeCodeVersion;
    if (minimum === undefined) continue;
    const order = compareVersions(minimum, required);
    if (order === null) {
      throw new Error(
        `Claude model ${model.id}: minimumClaudeCodeVersion "${minimum}" is not a version`,
      );
    }
    if (order === 1) required = minimum;
  }
  return required;
}

/**
 * What the installers are asked for when the newest published version could not be read (1.3.15:
 * otherwise the exact version, see decideClaudeCodeAction). The `stable` channel was 2.1.277 on
 * 2026-09-29, below the minimum, and install.sh without a target installs `stable`: the target is
 * always explicit.
 */
export const CLAUDE_CODE_INSTALL_TARGET = "latest";

/** What the official installers accept as a target (install.sh lines 6-9, install.ps1 1-4). */
const INSTALL_TARGET_PATTERN = /^(latest|stable|\d+\.\d+\.\d+)$/;

/**
 * 1.3.15: the newest published Claude Code, the same URL install.sh, install.ps1 and install.cmd
 * read. Its body is the bare version ("2.1.295", no newline on 2026-10-09).
 */
export const CLAUDE_CODE_LATEST_URL = "https://downloads.claude.ai/claude-code-releases/latest";

/** The body of CLAUDE_CODE_LATEST_URL, trimmed, when it is x.y.z; null for anything else. */
export function parseLatestVersion(body: string): string | null {
  const version = body.trim();
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** At most one attempt toward the newest version every 6 hours per machine (the brake). */
export const LATEST_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ClaudeCodeCopy {
  path: string;
  /** Null: unreadable or not starting; such a copy never counts as meeting anything. */
  version: string | null;
}

export type ClaudeCodeAction =
  /** Keep `path`: the copy new sessions get now (`current`) is the one to use. */
  | { kind: "ok"; path: string }
  /** Point new sessions at `path`, a copy already on the machine. */
  | { kind: "repoint"; path: string }
  /** Run the official installer for `target`: an exact version, or `latest` when unknown. */
  | { kind: "install"; target: string };

/**
 * 1.3.15 (V2): what to do with the Claude Code new sessions get. The minimum is the gate (below it
 * the machine is not ok), the newest published version is the goal:
 *  - the newest copy found that meets the minimum is the candidate (ties: `current`, then the first);
 *  - it is at the newest version, or the newest is unknown (`latest` null): use it;
 *  - below the newest, not braked: install the exact newest version;
 *  - below the newest, braked (an attempt within 6 hours): use it;
 *  - no copy meets the minimum: install, brake or not (the newest when known, else `latest`, the
 *    rule of 1.3.14: never an install toward a version that could not be read).
 * `current` is the copy new sessions get now: using it is "ok", using another one is "repoint".
 */
export function decideClaudeCodeAction(input: {
  copies: readonly ClaudeCodeCopy[];
  current?: string | null;
  required: string;
  latest: string | null;
  lastAttemptAt: Date | null;
  now: Date;
}): ClaudeCodeAction {
  const current = input.current ?? null;
  let best: ClaudeCodeCopy | null = null;
  for (const copy of input.copies) {
    if (copy.version === null || !meetsClaudeCodeMinimum(copy.version, input.required)) continue;
    if (best === null || best.version === null) {
      best = copy;
      continue;
    }
    const order = compareVersions(copy.version, best.version);
    if (order === 1 || (order === 0 && copy.path === current && best.path !== current)) {
      best = copy;
    }
  }
  if (best === null) return { kind: "install", target: input.latest ?? CLAUDE_CODE_INSTALL_TARGET };
  const choose = (copy: ClaudeCodeCopy): ClaudeCodeAction =>
    copy.path === current ? { kind: "ok", path: copy.path } : { kind: "repoint", path: copy.path };
  if (input.latest === null || meetsClaudeCodeMinimum(best.version, input.latest))
    return choose(best);
  const since =
    input.lastAttemptAt === null ? null : input.now.getTime() - input.lastAttemptAt.getTime();
  // An attempt "in the future" (a clock set back) does not brake: it would brake for good.
  if (since !== null && since >= 0 && since < LATEST_ATTEMPT_INTERVAL_MS) return choose(best);
  return { kind: "install", target: input.latest };
}

export type Env = Record<string, string | undefined>;

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Windows variable names are case-insensitive; POSIX ones are not. */
export function envKeys(env: Env, name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return name in env ? [name] : [];
  const wanted = name.toLowerCase();
  return Object.keys(env)
    .filter((key) => key.toLowerCase() === wanted)
    .sort();
}

export function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  for (const key of envKeys(env, name, platform)) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * The PATH key a child process will actually use. On Windows Node keeps, among keys equal but for
 * case, the first in sorted order ("PATH" before "Path"), so that is the one to read and write.
 */
export function pathEnvKey(env: Env, platform: NodeJS.Platform): string {
  return envKeys(env, "PATH", platform)[0] ?? (platform === "win32" ? "Path" : "PATH");
}

export function searchPathDirs(env: Env, platform: NodeJS.Platform): string[] {
  const raw = env[pathEnvKey(env, platform)] ?? "";
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir.length > 0);
}

/**
 * Where the official installer, its older "local" install (~/.claude/local), WinGet, npm and
 * Homebrew put `claude`, in that order.
 */
export function knownClaudeCodeDirs(
  platform: NodeJS.Platform,
  env: Env,
  homedir: string,
): string[] {
  const p = pathApi(platform);
  if (platform === "win32") {
    const profile = envValue(env, "USERPROFILE", platform) ?? homedir;
    const localAppData = envValue(env, "LOCALAPPDATA", platform);
    const appData = envValue(env, "APPDATA", platform);
    return [
      p.join(profile, ".local", "bin"),
      p.join(profile, ".claude", "local"),
      ...(localAppData ? [p.join(localAppData, "Microsoft", "WinGet", "Links")] : []),
      ...(appData ? [p.join(appData, "npm")] : []),
    ];
  }
  return [
    p.join(homedir, ".local", "bin"),
    p.join(homedir, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** File names a PATH search accepts for `claude`, in PATHEXT order on Windows. */
export function claudeCodeFileNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
}

function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normalize = (dir: string) => {
    const trimmed = dir.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
    return platform === "win32" ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
  };
  return normalize(a) === normalize(b);
}

export interface ClaudeCodeCandidate {
  path: string;
  dir: string;
  /** Found through the PATH the engine would inherit, not only in a known install folder. */
  onPath: boolean;
}

/** Every existing `claude`, PATH order first, then the known install folders not on PATH. */
export function claudeCodeCandidates(input: {
  platform: NodeJS.Platform;
  env: Env;
  homedir: string;
  exists: (file: string) => boolean;
}): ClaudeCodeCandidate[] {
  const { platform } = input;
  const p = pathApi(platform);
  const dirs: { dir: string; onPath: boolean }[] = [];
  const add = (dir: string, onPath: boolean) => {
    if (!dirs.some((seen) => sameDir(seen.dir, dir, platform))) dirs.push({ dir, onPath });
  };
  for (const dir of searchPathDirs(input.env, platform)) add(dir, true);
  for (const dir of knownClaudeCodeDirs(platform, input.env, input.homedir)) add(dir, false);

  const candidates: ClaudeCodeCandidate[] = [];
  for (const { dir, onPath } of dirs) {
    for (const name of claudeCodeFileNames(platform)) {
      const file = p.join(dir, name);
      if (input.exists(file)) candidates.push({ path: file, dir, onPath });
    }
  }
  return candidates;
}

/** `2.1.284 (Claude Code)`; a bare x.y.z is the fallback, as in the plugin's claude-version.ts. */
export function parseClaudeCodeVersion(output: string): string | null {
  const match =
    output.match(/\b(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/i) ??
    output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** An unknown version never meets the minimum. */
export function meetsClaudeCodeMinimum(
  version: string | null,
  minimum: string = MIN_CLAUDE_CODE_VERSION,
): boolean {
  if (version === null) return false;
  const order = compareVersions(version, minimum);
  return order === 0 || order === 1;
}

/**
 * What `claude --version` gave: a version; "unknown" when it ran but was too slow or said nothing
 * readable; "broken" when it did not start at all (not executable, wrong architecture).
 */
export type ClaudeCodeVersionRead = string | "unknown" | "broken";

export type ClaudeCodeResolution =
  | {
      status: "ready";
      path: string;
      /** Null when `--version` was slow or unreadable: used anyway, the plugin checks it. */
      version: string | null;
      /** A PATH search already finds this very file first: the engine's PATH needs no change. */
      firstOnPath: boolean;
    }
  | { status: "missing" }
  | {
      status: "too-old";
      /** Every copy found, with its version; null for one that does not start. */
      found: { path: string; version: string | null }[];
    };

/**
 * The newest `claude` that meets the minimum (1.3.15: not the first in PATH order; on equal
 * versions the earlier one, PATH order and then the known folders). A copy whose `--version` is
 * slow or unreadable is present with an unknown version: it is used when no copy is known to be
 * good, and never reinstalled over (the plugin checks the version itself). Only copies that are all
 * too old, or that do not start, call for the installer.
 */
export async function resolveClaudeCode(input: {
  platform: NodeJS.Platform;
  env: Env;
  homedir: string;
  exists: (file: string) => boolean;
  readVersion: (file: string) => Promise<ClaudeCodeVersionRead>;
  minimum?: string;
}): Promise<ClaudeCodeResolution> {
  const candidates = claudeCodeCandidates(input);
  if (candidates.length === 0) return { status: "missing" };
  const firstOnPath = candidates.find((candidate) => candidate.onPath) ?? null;
  const ready = (candidate: ClaudeCodeCandidate, version: string | null) => ({
    status: "ready" as const,
    path: candidate.path,
    version,
    firstOnPath: firstOnPath?.path === candidate.path,
  });
  const found: { path: string; version: string | null }[] = [];
  let unknown: ClaudeCodeCandidate | null = null;
  let best: { candidate: ClaudeCodeCandidate; version: string } | null = null;
  for (const candidate of candidates) {
    const read = await input.readVersion(candidate.path);
    if (read === "unknown") {
      unknown ??= candidate;
      continue;
    }
    const version = read === "broken" ? null : read;
    if (version !== null && meetsClaudeCodeMinimum(version, input.minimum)) {
      if (best === null || compareVersions(version, best.version) === 1) {
        best = { candidate, version };
      }
      continue;
    }
    found.push({ path: candidate.path, version });
  }
  if (best) return ready(best.candidate, best.version);
  if (unknown) return ready(unknown, null);
  return { status: "too-old", found };
}

/** The copies a resolution read, for decideClaudeCodeAction: the one it picked is the newest. */
export function resolutionCopies(resolution: ClaudeCodeResolution): ClaudeCodeCopy[] {
  if (resolution.status === "ready")
    return [{ path: resolution.path, version: resolution.version }];
  if (resolution.status === "missing") return [];
  return resolution.found.map(({ path: file, version }) => ({ path: file, version }));
}

/**
 * How the engine's private bin folder offers `claude` (only it: the folder Claude Code lives in may
 * hold other tools that would shadow the user's own, ~/.local/bin for uv and pipx for one):
 *  - macOS / Linux: a symlink, which follows Claude Code's own updates of its launcher.
 *  - Windows, claude.exe: a hard link. Paseo spawns claude without a shell, so a .cmd wrapper
 *    around an .exe would not start (Node refuses .cmd without a shell); a symlink needs Developer
 *    Mode. A hard link is the same file under a second name; it is made again at every launch.
 *  - Windows, claude.cmd (npm): a .cmd that calls it by absolute path; the original resolves its
 *    package relative to its own folder, so a link to it would not.
 */
export type ClaudeCodeShim =
  | { kind: "symlink"; file: string; target: string }
  | { kind: "hardlink"; file: string; target: string }
  | { kind: "cmd"; file: string; target: string; content: string };

export function claudeCodeShim(
  platform: NodeJS.Platform,
  target: string,
  shimDir: string,
): ClaudeCodeShim {
  if (platform !== "win32") {
    return { kind: "symlink", file: path.posix.join(shimDir, "claude"), target };
  }
  if (/\.(cmd|bat)$/i.test(target)) {
    // `%` would expand inside a batch file: doubled, it is a literal one.
    const quoted = target.replaceAll("%", "%%");
    return {
      kind: "cmd",
      file: path.win32.join(shimDir, "claude.cmd"),
      target,
      content: `@"${quoted}" %*\r\n`,
    };
  }
  return { kind: "hardlink", file: path.win32.join(shimDir, "claude.exe"), target };
}

/** A copy of `env` whose PATH starts with `dir`, under the one PATH key a child will read. */
export function prependToPath(env: Env, dir: string, platform: NodeJS.Platform): Env {
  const key = pathEnvKey(env, platform);
  const next: Env = { ...env };
  for (const other of envKeys(env, "PATH", platform)) {
    if (other !== key) delete next[other];
  }
  const current = next[key];
  next[key] = current ? `${dir}${platform === "win32" ? ";" : ":"}${current}` : dir;
  return next;
}

export interface InstallerCommand {
  command: string;
  args: string[];
  env: Env;
}

/**
 * The official installer, per user, no password and no elevation, for `target`: the exact newest
 * version (1.3.15), or `latest` when it could not be read:
 *  - Windows: install.ps1 through Windows PowerShell 5.1 by absolute path. PSModulePath is dropped
 *    because a value inherited from PowerShell 7 breaks 5.1's own modules (measured on the runner:
 *    install.ps1 failed with "Get-FileHash is not recognized"); TLS 1.2 is forced for older .NET.
 *  - macOS / Linux: install.sh through bash, with pipefail so a failed download is a failure, over
 *    HTTPS only (no redirect to plain HTTP) and TLS 1.2 or newer.
 */
export function claudeCodeInstallerCommand(
  platform: NodeJS.Platform,
  env: Env,
  target: string = CLAUDE_CODE_INSTALL_TARGET,
): InstallerCommand {
  // The target lands in a command line: only what the installers themselves accept.
  if (!INSTALL_TARGET_PATTERN.test(target)) {
    throw new Error(`Claude Code install target "${target}" is not a version`);
  }
  if (platform === "win32") {
    const systemRoot = envValue(env, "SystemRoot", platform) ?? "C:\\Windows";
    const installEnv: Env = { ...env };
    for (const key of envKeys(env, "PSModulePath", platform)) delete installEnv[key];
    return {
      command: path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; " +
          `& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://claude.ai/install.ps1'))) ${target}`,
      ],
      env: installEnv,
    };
  }
  return {
    command: "/bin/bash",
    args: [
      "-c",
      `set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh | bash -s -- ${target}`,
    ],
    env: { ...env },
  };
}

// ---------------------------------------------------------------------------
// The setup flow: one attempt per launch or per "Try again", never a wait on the user
// ---------------------------------------------------------------------------

export type SetupComponent = "claude-code" | "git-bash";

export interface SetupFailure {
  component: SetupComponent;
  message: string;
  detail: string;
}

export type SetupState =
  | { phase: "installing"; component: SetupComponent; attempt: number }
  | ({ phase: "failed" } & SetupFailure);

export interface InstallerRun {
  ok: boolean;
  /** The installer's own output (its tail), for the screen and the log. */
  output: string;
  /** Stopped, with every process it started, because it ran past its time limit. */
  timedOut?: boolean;
  /** What to tell the user when the step knows better than the generic message. */
  message?: string;
}

export interface SetupScreen {
  /** Puts the setup screen in front of the user (opening it on the first call). */
  show(state: SetupState): void;
}

export type SetupLog = (message: string, details?: Record<string, unknown>) => void;

const DETAIL_LIMIT = 600;

export function outputTail(text: string, limit: number = DETAIL_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/**
 * One attempt behind the setup screen. A failure is returned, not shown and not waited on: the
 * engine starts without this component and the caller decides what the screen says (nothing, if
 * the user closed it). "Try again" is a new attempt, started by the caller.
 */
export async function attemptSetup<T>(input: {
  component: SetupComponent;
  attempt: number;
  screen: SetupScreen;
  log: SetupLog;
  run: () => Promise<{ result: T | null; run: InstallerRun; message: string }>;
}): Promise<{ status: "ready"; result: T } | { status: "failed"; failure: SetupFailure }> {
  input.screen.show({ phase: "installing", component: input.component, attempt: input.attempt });
  const { result, run, message } = await input.run();
  if (result !== null) return { status: "ready", result };
  input.log(`${input.component} setup failed`, {
    attempt: input.attempt,
    installerOk: run.ok,
    timedOut: run.timedOut === true,
    output: outputTail(run.output, 4000),
  });
  return {
    status: "failed",
    failure: { component: input.component, message, detail: outputTail(run.output) },
  };
}

export interface ClaudeCodeSetupDeps {
  resolve(): Promise<ClaudeCodeResolution>;
  install(): Promise<InstallerRun>;
  /** The n-th attempt to install in this run of the app: 2 and up reads "Trying again". */
  attempt?: number;
  /** The version resolve() asks for, for the failure message. */
  minimum?: string;
  screen: SetupScreen;
  log: SetupLog;
}

type ReadyClaudeCode = Extract<ClaudeCodeResolution, { status: "ready" }>;

export type ClaudeCodeSetupOutcome =
  | { status: "ready"; resolution: ReadyClaudeCode; installed: boolean }
  | { status: "failed"; failure: SetupFailure };

function claudeCodeFailure(
  run: InstallerRun,
  after: ClaudeCodeResolution,
  minimum: string,
): string {
  if (run.timedOut) {
    return "Claude Code could not be installed: the installer did not finish in time. Check your internet connection and try again.";
  }
  if (!run.ok) {
    return "Claude Code could not be installed. Check your internet connection and try again.";
  }
  if (after.status === "too-old") {
    return `Claude Code was installed, but the copy Orchestra finds is older than ${minimum}.`;
  }
  return "Claude Code was installed, but Orchestra cannot find it.";
}

/**
 * Finds Claude Code; when it is missing or too old, runs the official installer once behind the
 * setup screen and looks again. A copy that is already there never shows anything.
 */
export async function ensureClaudeCode(deps: ClaudeCodeSetupDeps): Promise<ClaudeCodeSetupOutcome> {
  const first = await deps.resolve();
  if (first.status === "ready") return { status: "ready", resolution: first, installed: false };
  deps.log("Claude Code needs installing", {
    reason: first.status,
    ...(first.status === "too-old" ? { found: first.found } : {}),
  });
  const done = await attemptSetup<ReadyClaudeCode>({
    component: "claude-code",
    attempt: deps.attempt ?? 1,
    screen: deps.screen,
    log: deps.log,
    run: async () => {
      const run = await deps.install();
      const after = await deps.resolve();
      // What counts is a usable copy afterwards, not the installer's exit code alone.
      return {
        result: after.status === "ready" ? after : null,
        run,
        message: claudeCodeFailure(run, after, deps.minimum ?? MIN_CLAUDE_CODE_VERSION),
      };
    },
  });
  if (done.status === "failed") return done;
  deps.log("Claude Code installed", { path: done.result.path, version: done.result.version });
  return { status: "ready", resolution: done.result, installed: true };
}

// ---------------------------------------------------------------------------
// While Orchestra runs: the re-check, and what the Orchestra page is told
// ---------------------------------------------------------------------------

/**
 * `window.orchestraDesktop.claudeCode`: the Claude Code new sessions of the engine get, the
 * version this build requires, whether it meets it, and when this was measured.
 */
export interface ClaudeCodeStatus {
  version: string | null;
  required: string;
  ok: boolean;
  /** ISO 8601. */
  checkedAt: string;
}

export function claudeCodeStatus(
  version: string | null,
  required: string,
  at: Date,
): ClaudeCodeStatus {
  return {
    version,
    required,
    ok: meetsClaudeCodeMinimum(version, required),
    checkedAt: at.toISOString(),
  };
}

/** What the setup or a check could not do, for Settings (1.3.15, V1). */
export interface ClaudeCodeFailureReport {
  /** At most 300 characters. */
  message: string;
  /** The tail of the installer's output, at most 600 characters. */
  detail: string;
  /** ISO 8601. */
  at: string;
}

/**
 * 1.3.15: what the Orchestra page reads as its Claude Code status: the status, the newest
 * published version last read (null: never read, or the read failed), the last failure that left
 * the machine below the minimum or without Claude Code (null once it is ok again), and the machine.
 */
export interface ClaudeCodeReport extends ClaudeCodeStatus {
  latest: string | null;
  failure: ClaudeCodeFailureReport | null;
  platform: "darwin" | "win32" | "linux";
  /** os.release(), at most 64 characters. */
  osVersion: string;
}

export const FAILURE_MESSAGE_LIMIT = 300;
export const FAILURE_DETAIL_LIMIT = 600;
export const OS_VERSION_LIMIT = 64;

function clipHead(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clipTail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-(limit - 1))}` : trimmed;
}

export function claudeCodeReport(
  status: ClaudeCodeStatus,
  extras: {
    latest: string | null;
    failure: { message: string; detail: string; at: Date } | null;
    platform: NodeJS.Platform;
    osVersion: string;
  },
): ClaudeCodeReport {
  const platform =
    extras.platform === "darwin" || extras.platform === "win32" ? extras.platform : "linux";
  return {
    ...status,
    latest: extras.latest,
    failure:
      extras.failure === null
        ? null
        : {
            message: clipHead(extras.failure.message.trim(), FAILURE_MESSAGE_LIMIT),
            detail: clipTail(extras.failure.detail, FAILURE_DETAIL_LIMIT),
            at: extras.failure.at.toISOString(),
          },
    platform,
    osVersion: extras.osVersion.slice(0, OS_VERSION_LIMIT),
  };
}

/** The version a resolution stands for: the copy used, or the newest copy found too old. */
export function resolutionVersion(resolution: ClaudeCodeResolution): string | null {
  if (resolution.status === "ready") return resolution.version;
  if (resolution.status === "missing") return null;
  let best: string | null = null;
  for (const { version } of resolution.found) {
    if (version === null) continue;
    if (best === null || compareVersions(version, best) === 1) best = version;
  }
  return best;
}

export type ClaudeCodeRecheckAction =
  /** The engine's copy meets the requirement: nothing to do. */
  | "current"
  /** `--version` of the engine's copy was slow or unreadable: never reinstalled over. */
  | "unreadable"
  /** Orchestra did not launch this engine, or the check only measures: nothing changed. */
  | "report-only"
  /** Another copy already met the requirement: new sessions now get it. */
  | "repointed"
  /** The official installer ran and new sessions now get the copy it installed. */
  | "installed"
  /**
   * Still below the requirement, or (status ok) still below the newest version: the next check
   * tries again.
   */
  | "failed";

export interface ClaudeCodeRecheckOutcome {
  action: ClaudeCodeRecheckAction;
  status: ClaudeCodeStatus;
  /** The copy new sessions get, when this check changed it. */
  path?: string;
  /** For the log (and, below the minimum, for Settings): why a check that had to act could not. */
  reason?: string;
  /** The tail of the installer's output, when it ran and did not get there. */
  detail?: string;
}

export interface ClaudeCodeRecheckDeps {
  required: string;
  /**
   * The `claude` new sessions of the engine run, as they would start it (the engine's private
   * link to it); null when it has none (the setup at launch failed).
   */
  engineCopy: string | null;
  /** Orchestra launched this engine: it may install Claude Code and point the link elsewhere. */
  manage: boolean;
  /** 1.3.15: the newest published version (null or absent: unknown, the minimum is the rule). */
  latest?: string | null;
  /** 1.3.15: when the last attempt toward the newest version started (the 6-hour brake). */
  lastAttemptAt?: () => Date | null;
  /** 1.3.15: called right before the installer runs for an exact version (persists the brake). */
  recordAttempt?: (target: string) => void;
  readVersion(file: string): Promise<ClaudeCodeVersionRead>;
  /** resolveClaudeCode() with `minimum` = `required`. */
  resolve(): Promise<ClaudeCodeResolution>;
  /** The official installer for `target`, in the background: never a window, never a stop. */
  install(target: string): Promise<InstallerRun>;
  /** Points the engine's link at `file`; false when it could not. */
  repoint(file: string): boolean;
  now(): Date;
  log: SetupLog;
}

/**
 * The periodic check: reads the version of the copy new sessions get and, when Orchestra launched
 * the engine, keeps it at the newest published version (decideClaudeCodeAction): first by pointing
 * at a copy that already is (the native copy next to an old Homebrew or npm one, a Windows link
 * still on the replaced file), else with the official installer for that exact version. Below the
 * minimum it is the same, with no brake. Running sessions are never touched: the installer keeps
 * the version they run (measured on macOS, Linux and Windows, docs/FIGMENTA.md) and only the
 * engine's link changes, never a file a session runs. An attempt toward the newest version that
 * fails while the copy still meets the minimum is "failed" with an ok status: the log, nothing else.
 */
export async function recheckClaudeCode(
  deps: ClaudeCodeRecheckDeps,
): Promise<ClaudeCodeRecheckOutcome> {
  const { required } = deps;
  const latest = deps.latest ?? null;
  const status = (version: string | null) => claudeCodeStatus(version, required, deps.now());

  let engineVersion: string | null = null;
  if (deps.engineCopy !== null) {
    const read = await deps.readVersion(deps.engineCopy);
    if (read === "unknown") return { action: "unreadable", status: status(null) };
    engineVersion = read === "broken" ? null : read;
  }
  const engineMeets = meetsClaudeCodeMinimum(engineVersion, required);
  const atLatest = latest === null || meetsClaudeCodeMinimum(engineVersion, latest);
  if (engineMeets && (!deps.manage || atLatest)) {
    return { action: "current", status: status(engineVersion) };
  }

  if (!deps.manage) {
    // What new sessions get is the engine's copy when it has one; otherwise what the machine has.
    if (deps.engineCopy !== null) return { action: "report-only", status: status(engineVersion) };
    const resolution = await deps.resolve();
    return { action: "report-only", status: status(resolutionVersion(resolution)) };
  }
  return bringClaudeCodeUp(deps, engineVersion);
}

/** Points the engine's link at a resolved copy; null when the resolution has no usable copy. */
function pointEngineAt(
  deps: ClaudeCodeRecheckDeps,
  resolution: ClaudeCodeResolution,
  action: "repointed" | "installed",
  engineVersion: string | null,
): ClaudeCodeRecheckOutcome | null {
  if (resolution.status !== "ready" || resolution.version === null) return null;
  if (!deps.repoint(resolution.path)) {
    return {
      action: "failed",
      status: claudeCodeStatus(engineVersion, deps.required, deps.now()),
      reason: `the engine's link to ${resolution.path} could not be written`,
    };
  }
  deps.log(`Claude Code for new sessions: ${action}`, {
    path: resolution.path,
    version: resolution.version,
    before: engineVersion,
  });
  return {
    action,
    status: claudeCodeStatus(resolution.version, deps.required, deps.now()),
    path: resolution.path,
  };
}

function installFailureReason(run: InstallerRun, after: ClaudeCodeResolution): string {
  if (run.timedOut) return "the installer did not finish in time";
  if (run.ok) return `after the installer the copy found is ${after.status}`;
  return "the installer failed";
}

/** recheckClaudeCode for an engine Orchestra launched whose copy is below the minimum or the newest. */
async function bringClaudeCodeUp(
  deps: ClaudeCodeRecheckDeps,
  engineVersion: string | null,
): Promise<ClaudeCodeRecheckOutcome> {
  const { required } = deps;
  const latest = deps.latest ?? null;
  const engineMeets = meetsClaudeCodeMinimum(engineVersion, required);
  const status = () => claudeCodeStatus(engineVersion, required, deps.now());

  const before = await deps.resolve();
  const engine: ClaudeCodeCopy[] =
    deps.engineCopy === null ? [] : [{ path: deps.engineCopy, version: engineVersion }];
  const decision = decideClaudeCodeAction({
    copies: [...engine, ...resolutionCopies(before)],
    current: deps.engineCopy,
    required,
    latest,
    lastAttemptAt: deps.lastAttemptAt?.() ?? null,
    now: deps.now(),
  });
  if (decision.kind === "ok") {
    // Braked: below the newest version, at or above the minimum.
    deps.log("Claude Code is below the newest version: last attempt less than 6 hours ago", {
      engineVersion,
      latest,
    });
    return { action: "current", status: status() };
  }
  if (decision.kind === "repoint") {
    const pointed = pointEngineAt(deps, before, "repointed", engineVersion);
    return pointed ?? { action: "failed", status: status(), reason: "no copy to use" };
  }

  deps.log(
    engineMeets
      ? "Claude Code is below the newest version: installing it in the background"
      : "Claude Code is below what Orchestra requires: installing in the background",
    {
      required,
      latest,
      target: decision.target,
      engineVersion,
      found: before.status === "too-old" ? before.found : [],
    },
  );
  if (decision.target !== CLAUDE_CODE_INSTALL_TARGET) deps.recordAttempt?.(decision.target);
  const run = await deps.install(decision.target);
  const after = await deps.resolve();
  const afterVersion = after.status === "ready" ? after.version : null;
  const improved =
    afterVersion !== null &&
    (engineVersion === null || compareVersions(afterVersion, engineVersion) === 1);
  if (improved) {
    const pointed = pointEngineAt(deps, after, run.ok ? "installed" : "repointed", engineVersion);
    if (pointed) return pointed;
  }
  const reason = installFailureReason(run, after);
  return {
    action: "failed",
    status: status(),
    reason: engineMeets ? `toward ${decision.target}: ${reason}` : reason,
    detail: outputTail(run.output, FAILURE_DETAIL_LIMIT - 1),
  };
}
