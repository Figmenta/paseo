// Figmenta fork: Git Bash for the engine Orchestra starts itself, on Windows.
//
// Measured on windows-latest with Claude Code 2.1.284, Git hidden (plugin repo, branch
// probe/zero-setup, run 36536223926):
//  - without Git Bash Claude Code starts, but runs hooks through PowerShell and offers a PowerShell
//    tool instead of Bash; the plugin's expiry hook (POSIX sh) then fails OPEN: the prompt reaches
//    the API.
//  - MinGit has no bash.exe; CLAUDE_CODE_GIT_BASH_PATH on its sh.exe runs the hook, but the Bash
//    tool fails ("Exit code 1"). MinGit's cmd on PATH is not detected at all.
//  - PortableGit passes everything, by CLAUDE_CODE_GIT_BASH_PATH (also in a folder with a space)
//    or with its cmd on PATH: the hook blocks, the Bash tool runs bash 5.3 with git 2.56.
// So Orchestra for Windows ships the PortableGit self-extractor (scripts/figmenta-portable-git.js)
// and, on a machine with no Git Bash of its own, unpacks it once per user under
// %LOCALAPPDATA%\Orchestra\git and points Claude Code at it.
//
// Pure: the file system, the extraction and the screen are handed in.

import path from "node:path";
import {
  attemptSetup,
  envKeys,
  envValue,
  pathEnvKey,
  searchPathDirs,
  type Env,
  type InstallerRun,
  type SetupFailure,
  type SetupLog,
  type SetupScreen,
} from "./claude-code-setup.js";

export const GIT_BASH_ENV = "CLAUDE_CODE_GIT_BASH_PATH";
/** Written in the unpacked folder once bin\bash.exe is there: a half-unpacked folder has none. */
export const BUNDLED_GIT_READY_MARKER = ".orchestra-ready";

const win = path.win32;

export type GitBashResolution =
  | {
      status: "found";
      bashPath: string;
      /** Claude Code finds this one by itself; false means it must be named in the environment. */
      seenByClaudeCode: boolean;
    }
  | { status: "absent" };

/**
 * The machine's own Git Bash, as Claude Code looks for it: CLAUDE_CODE_GIT_BASH_PATH, then
 * `<folder of a git.exe on PATH>\..\bin\bash.exe` (why PortableGit's cmd is found and MinGit's is
 * not). Then the usual install folders, which Claude Code is told about explicitly.
 */
export function resolveSystemGitBash(input: {
  env: Env;
  exists: (file: string) => boolean;
}): GitBashResolution {
  const { env, exists } = input;
  const configured = envValue(env, GIT_BASH_ENV, "win32");
  if (configured && exists(configured)) {
    return { status: "found", bashPath: configured, seenByClaudeCode: true };
  }
  // A configured path that does not exist is what Claude Code would try first: name the real one.
  const seen = configured === undefined;
  for (const dir of searchPathDirs(env, "win32")) {
    if (!exists(win.join(dir, "git.exe"))) continue;
    const bash = win.join(dir, "..", "bin", "bash.exe");
    if (exists(bash)) return { status: "found", bashPath: bash, seenByClaudeCode: seen };
  }
  const localAppData = envValue(env, "LOCALAPPDATA", "win32");
  const roots = [
    envValue(env, "ProgramFiles", "win32"),
    envValue(env, "ProgramW6432", "win32"),
    localAppData ? win.join(localAppData, "Programs") : undefined,
  ].filter((dir): dir is string => dir !== undefined);
  for (const root of roots) {
    const bash = win.join(root, "Git", "bin", "bash.exe");
    if (exists(bash)) return { status: "found", bashPath: bash, seenByClaudeCode: false };
  }
  return { status: "absent" };
}

export interface BundledGitLayout {
  /** The self-extractor inside Orchestra's resources. */
  archive: string;
  /** Its SHA-256 as the build pinned it (portable-git.json): checked again before it is run. */
  sha256: string;
  /** Where it is unpacked: %LOCALAPPDATA%\Orchestra\git\<archive name without .7z.exe>. */
  dir: string;
  bashPath: string;
  cmdDir: string;
  marker: string;
}

export function bundledGitLayout(
  archive: string,
  sha256: string,
  localAppData: string,
): BundledGitLayout {
  const name = win.basename(archive).replace(/\.7z\.exe$/i, "");
  const dir = win.join(localAppData, "Orchestra", "git", name);
  return {
    archive,
    sha256: sha256.toLowerCase(),
    dir,
    bashPath: win.join(dir, "bin", "bash.exe"),
    cmdDir: win.join(dir, "cmd"),
    marker: win.join(dir, BUNDLED_GIT_READY_MARKER),
  };
}

/**
 * The self-extractor's switches: into `dir`, yes to everything, no window. Measured on
 * windows-latest (plugin repo, probe/zero-setup, run 36537693095), from Node, archive and target
 * both in folders with spaces: -o"<dir>" -y -gm2 unpacks into <dir> in about 20 s, runs the
 * post-install step and leaves no process behind; with -gm2 BEFORE -o the extractor exits 0 and
 * ignores -o, unpacking next to the archive instead. The -o value is quoted here, so the caller
 * passes these arguments verbatim (windowsVerbatimArguments, argv0 quoted by hand).
 */
export function portableGitExtractArgs(dir: string): string[] {
  return [`-o"${dir}"`, "-y", "-gm2"];
}

/**
 * A copy of `env` where Claude Code uses `bashPath`, and — for Orchestra's own copy, when the
 * machine has no git at all — its cmd folder at the END of PATH, so the engine has `git` too
 * without shadowing anything the user installed.
 */
export function withGitBash(env: Env, bashPath: string, appendDir: string | null): Env {
  const next: Env = { ...env };
  for (const key of envKeys(env, GIT_BASH_ENV, "win32")) delete next[key];
  next[GIT_BASH_ENV] = bashPath;
  if (appendDir) {
    const key = pathEnvKey(next, "win32");
    for (const other of envKeys(next, "PATH", "win32")) {
      if (other !== key) delete next[other];
    }
    const current = next[key];
    next[key] = current ? `${current};${appendDir}` : appendDir;
  }
  return next;
}

export type GitBashOutcome =
  | { status: "system"; bashPath: string; explicit: boolean }
  | { status: "bundled"; layout: BundledGitLayout; unpacked: boolean }
  | { status: "unavailable" }
  | { status: "failed"; failure: SetupFailure };

export interface GitBashSetupDeps {
  resolveSystem(): GitBashResolution;
  /** Orchestra's own PortableGit, or null when this build carries none (a development run). */
  bundled(): BundledGitLayout | null;
  exists(file: string): boolean;
  /**
   * Checks the archive against layout.sha256, unpacks it into layout.dir and leaves the ready
   * marker once bash.exe is there.
   */
  unpack(layout: BundledGitLayout): Promise<InstallerRun>;
  /** The n-th attempt in this run of the app: 2 and up reads "Trying again". */
  attempt?: number;
  screen: SetupScreen;
  log: SetupLog;
}

/**
 * The machine's Git Bash when it has one; otherwise Orchestra's own, unpacked behind the setup
 * screen the first time (a minute at most, no network). One attempt: a failure is returned.
 */
export async function ensureGitBash(deps: GitBashSetupDeps): Promise<GitBashOutcome> {
  const system = deps.resolveSystem();
  if (system.status === "found") {
    return { status: "system", bashPath: system.bashPath, explicit: !system.seenByClaudeCode };
  }
  const layout = deps.bundled();
  if (layout === null) {
    deps.log("no Git Bash on this machine and none bundled: hooks and the Bash tool will not work");
    return { status: "unavailable" };
  }
  if (deps.exists(layout.marker) && deps.exists(layout.bashPath)) {
    return { status: "bundled", layout, unpacked: false };
  }
  deps.log("unpacking the bundled Git Bash", { archive: layout.archive, dir: layout.dir });
  const done = await attemptSetup<BundledGitLayout>({
    component: "git-bash",
    attempt: deps.attempt ?? 1,
    screen: deps.screen,
    log: deps.log,
    run: async () => {
      const run = await deps.unpack(layout);
      const ready = deps.exists(layout.marker) && deps.exists(layout.bashPath);
      return {
        result: ready ? layout : null,
        run,
        message:
          run.message ??
          (run.timedOut
            ? "Git Bash, which Claude Code needs on Windows, could not be unpacked in time. Try again."
            : "Git Bash, which Claude Code needs on Windows, could not be unpacked. Check that the disk has 500 MB free and try again."),
      };
    },
  });
  if (done.status === "failed") return done;
  return { status: "bundled", layout, unpacked: true };
}
