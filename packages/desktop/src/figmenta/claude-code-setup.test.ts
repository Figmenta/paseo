import { describe, expect, it, vi } from "vitest";
// The manifest as the source has it (what the next build bundles) and as this checkout's built
// server package has it (what the desktop app imports at runtime): they must agree.
import { CLAUDE_MODEL_MANIFEST as SOURCE_MANIFEST } from "../../../server/src/server/agent/providers/claude/model-manifest.js";
import { CLAUDE_MODEL_MANIFEST as BUILT_MANIFEST } from "@getpaseo/server/claude-model-manifest";
import { compareVersions } from "./semver.js";
import {
  CLAUDE_CODE_INSTALL_TARGET,
  claudeCodeStatus,
  recheckClaudeCode,
  requiredClaudeCodeVersion,
  resolutionVersion,
  type ClaudeCodeRecheckDeps,
  claudeCodeCandidates,
  claudeCodeInstallerCommand,
  claudeCodeShim,
  ensureClaudeCode,
  knownClaudeCodeDirs,
  meetsClaudeCodeMinimum,
  MIN_CLAUDE_CODE_VERSION,
  parseClaudeCodeVersion,
  pathEnvKey,
  prependToPath,
  resolveClaudeCode,
  searchPathDirs,
  type ClaudeCodeResolution,
  type ClaudeCodeVersionRead,
  type InstallerRun,
  type SetupScreen,
  type SetupState,
} from "./claude-code-setup.js";

// Federico's PC on 2026-09-29: user "Figmenta", the official installer's claude.exe in
// %USERPROFILE%\.local\bin, a folder the engine's PATH did not have.
const WIN_ENV = {
  Path: "C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\nodejs\\",
  USERPROFILE: "C:\\Users\\Figmenta",
  LOCALAPPDATA: "C:\\Users\\Figmenta\\AppData\\Local",
  APPDATA: "C:\\Users\\Figmenta\\AppData\\Roaming",
  SystemRoot: "C:\\Windows",
};
const WIN_NATIVE = "C:\\Users\\Figmenta\\.local\\bin\\claude.exe";
const WIN_NPM = "C:\\Users\\Figmenta\\AppData\\Roaming\\npm\\claude.cmd";

/** Every file that exists, with what its `--version` gives. */
function fs(files: Record<string, ClaudeCodeVersionRead>) {
  return {
    exists: (file: string) => file in files,
    readVersion: vi.fn(async (file: string): Promise<ClaudeCodeVersionRead> => files[file]),
  };
}

describe("parseClaudeCodeVersion / meetsClaudeCodeMinimum", () => {
  it("reads `claude --version` as the plugin does", () => {
    expect(parseClaudeCodeVersion("2.1.284 (Claude Code)\n")).toBe("2.1.284");
    expect(parseClaudeCodeVersion("warning: x 1.2\n2.1.283 (Claude Code)")).toBe("2.1.283");
    expect(parseClaudeCodeVersion("2.1.290")).toBe("2.1.290");
    expect(parseClaudeCodeVersion("command not found")).toBeNull();
  });

  it("accepts 2.1.283 and newer, numerically, and never an unknown version", () => {
    expect(MIN_CLAUDE_CODE_VERSION).toBe("2.1.283");
    expect(meetsClaudeCodeMinimum("2.1.283")).toBe(true);
    expect(meetsClaudeCodeMinimum("2.1.284")).toBe(true);
    expect(meetsClaudeCodeMinimum("2.2.0")).toBe(true);
    expect(meetsClaudeCodeMinimum("3.0.0")).toBe(true);
    expect(meetsClaudeCodeMinimum("2.1.282")).toBe(false);
    expect(meetsClaudeCodeMinimum("2.1.30")).toBe(false);
    expect(meetsClaudeCodeMinimum("1.9.999")).toBe(false);
    expect(meetsClaudeCodeMinimum(null)).toBe(false);
  });
});

describe("PATH handling", () => {
  it("uses the key a child process reads: the existing one, PATH first among case variants", () => {
    expect(pathEnvKey({ Path: "x" }, "win32")).toBe("Path");
    expect(pathEnvKey({ Path: "x", PATH: "y" }, "win32")).toBe("PATH");
    expect(pathEnvKey({}, "win32")).toBe("Path");
    expect(pathEnvKey({ Path: "x" }, "darwin")).toBe("PATH");
  });

  it("splits PATH per platform, without quotes or empty entries", () => {
    expect(searchPathDirs({ Path: 'C:\\a;;"C:\\b c";' }, "win32")).toEqual(["C:\\a", "C:\\b c"]);
    expect(searchPathDirs({ PATH: "/usr/bin::/bin" }, "darwin")).toEqual(["/usr/bin", "/bin"]);
    expect(searchPathDirs({}, "darwin")).toEqual([]);
  });

  it("prepends under the existing key and leaves a single PATH on Windows", () => {
    expect(prependToPath({ Path: "C:\\a", X: "1" }, "C:\\new", "win32")).toEqual({
      Path: "C:\\new;C:\\a",
      X: "1",
    });
    expect(prependToPath({ Path: "C:\\a", PATH: "C:\\b" }, "C:\\new", "win32")).toEqual({
      PATH: "C:\\new;C:\\b",
    });
    expect(prependToPath({ PATH: "/usr/bin" }, "/Users/me/.local/bin", "darwin")).toEqual({
      PATH: "/Users/me/.local/bin:/usr/bin",
    });
    expect(prependToPath({}, "/x", "darwin")).toEqual({ PATH: "/x" });
  });

  it("does not modify the environment it is given", () => {
    const env = { Path: "C:\\a" };
    prependToPath(env, "C:\\new", "win32");
    expect(env).toEqual({ Path: "C:\\a" });
  });
});

describe("where Claude Code is looked for", () => {
  it("knows the installer, its older local install, WinGet and npm folders on Windows", () => {
    expect(knownClaudeCodeDirs("win32", WIN_ENV, "C:\\ignored")).toEqual([
      "C:\\Users\\Figmenta\\.local\\bin",
      "C:\\Users\\Figmenta\\.claude\\local",
      "C:\\Users\\Figmenta\\AppData\\Local\\Microsoft\\WinGet\\Links",
      "C:\\Users\\Figmenta\\AppData\\Roaming\\npm",
    ]);
  });

  it("knows the installer, its older local install and Homebrew folders on macOS", () => {
    expect(knownClaudeCodeDirs("darwin", {}, "/Users/me")).toEqual([
      "/Users/me/.local/bin",
      "/Users/me/.claude/local",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  it("lists PATH hits first, then known folders; a known folder already on PATH counts as PATH", () => {
    const env = { ...WIN_ENV, Path: `C:\\tools;c:\\users\\figmenta\\.local\\bin\\` };
    const candidates = claudeCodeCandidates({
      platform: "win32",
      env,
      homedir: "C:\\Users\\Figmenta",
      exists: (file) =>
        [
          "C:\\tools\\claude.cmd",
          "c:\\users\\figmenta\\.local\\bin\\claude.exe",
          WIN_NATIVE,
          WIN_NPM,
        ].includes(file),
    });
    expect(candidates).toEqual([
      { path: "C:\\tools\\claude.cmd", dir: "C:\\tools", onPath: true },
      {
        path: "c:\\users\\figmenta\\.local\\bin\\claude.exe",
        dir: "c:\\users\\figmenta\\.local\\bin\\",
        onPath: true,
      },
      {
        path: WIN_NPM,
        dir: "C:\\Users\\Figmenta\\AppData\\Roaming\\npm",
        onPath: false,
      },
    ]);
  });

  it("prefers claude.exe to claude.cmd in the same folder, as PATHEXT does", () => {
    const dir = "C:\\Users\\Figmenta\\AppData\\Roaming\\npm";
    const candidates = claudeCodeCandidates({
      platform: "win32",
      env: { Path: dir },
      homedir: "C:\\Users\\Figmenta",
      exists: (file) => file === `${dir}\\claude.exe` || file === `${dir}\\claude.cmd`,
    });
    expect(candidates.map((c) => c.path)).toEqual([`${dir}\\claude.exe`, `${dir}\\claude.cmd`]);
  });
});

describe("resolveClaudeCode", () => {
  it("the 2026-09-29 PC: installed but off PATH -> ready, not first on PATH", async () => {
    const files = fs({ [WIN_NATIVE]: "2.1.284" });
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env: WIN_ENV,
      homedir: "C:\\Users\\Figmenta",
      ...files,
    });
    expect(resolution).toEqual({
      status: "ready",
      path: WIN_NATIVE,
      version: "2.1.284",
      firstOnPath: false,
    });
  });

  it("changes nothing when the first claude on PATH is good", async () => {
    const env = { ...WIN_ENV, Path: `C:\\Users\\Figmenta\\.local\\bin;${WIN_ENV.Path}` };
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env,
      homedir: "C:\\Users\\Figmenta",
      ...fs({ [WIN_NATIVE]: "2.1.284" }),
    });
    expect(resolution).toMatchObject({ status: "ready", firstOnPath: true });
  });

  it("puts a good copy ahead of an older one that PATH would find first", async () => {
    const env = { ...WIN_ENV, Path: `C:\\Users\\Figmenta\\AppData\\Roaming\\npm;${WIN_ENV.Path}` };
    const files = fs({ [WIN_NPM]: "2.1.200", [WIN_NATIVE]: "2.1.284" });
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env,
      homedir: "C:\\Users\\Figmenta",
      ...files,
    });
    expect(resolution).toEqual({
      status: "ready",
      path: WIN_NATIVE,
      version: "2.1.284",
      firstOnPath: false,
    });
  });

  it("puts a good copy later on PATH ahead of an older one earlier on PATH", async () => {
    const files = fs({ "/usr/local/bin/claude": "2.1.100", "/opt/homebrew/bin/claude": "2.1.284" });
    const resolution = await resolveClaudeCode({
      platform: "darwin",
      env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin" },
      homedir: "/Users/me",
      ...files,
    });
    expect(resolution).toMatchObject({
      status: "ready",
      path: "/opt/homebrew/bin/claude",
      firstOnPath: false,
    });
  });

  it("stops reading versions at the first good copy", async () => {
    const files = fs({ [WIN_NATIVE]: "2.1.284", [WIN_NPM]: "2.1.290" });
    await resolveClaudeCode({ platform: "win32", env: WIN_ENV, homedir: "C:\\x", ...files });
    expect(files.readVersion).toHaveBeenCalledTimes(1);
  });

  it("macOS opened from the Finder: ~/.local/bin is not on PATH", async () => {
    const resolution = await resolveClaudeCode({
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      homedir: "/Users/me",
      ...fs({ "/Users/me/.local/bin/claude": "2.1.284" }),
    });
    expect(resolution).toMatchObject({
      status: "ready",
      path: "/Users/me/.local/bin/claude",
      firstOnPath: false,
    });
  });

  it("finds the older local install in ~/.claude/local", async () => {
    const resolution = await resolveClaudeCode({
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      homedir: "/Users/me",
      ...fs({ "/Users/me/.claude/local/claude": "2.1.290" }),
    });
    expect(resolution).toEqual({
      status: "ready",
      path: "/Users/me/.claude/local/claude",
      version: "2.1.290",
      firstOnPath: false,
    });
  });

  it("a copy whose --version is slow or unreadable is used, never reinstalled over", async () => {
    const env = { ...WIN_ENV, Path: `C:\\Users\\Figmenta\\AppData\\Roaming\\npm;${WIN_ENV.Path}` };
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env,
      homedir: "C:\\Users\\Figmenta",
      ...fs({ [WIN_NPM]: "2.1.282", [WIN_NATIVE]: "unknown" }),
    });
    expect(resolution).toEqual({
      status: "ready",
      path: WIN_NATIVE,
      version: null,
      firstOnPath: false,
    });
  });

  it("an unknown version on the first copy on PATH needs no PATH change", async () => {
    const resolution = await resolveClaudeCode({
      platform: "darwin",
      env: { PATH: "/Users/me/.local/bin:/usr/bin" },
      homedir: "/Users/me",
      ...fs({ "/Users/me/.local/bin/claude": "unknown" }),
    });
    expect(resolution).toMatchObject({ status: "ready", version: null, firstOnPath: true });
  });

  it("a copy known to be good wins over an earlier one of unknown version", async () => {
    const env = { ...WIN_ENV, Path: `C:\\Users\\Figmenta\\AppData\\Roaming\\npm;${WIN_ENV.Path}` };
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env,
      homedir: "C:\\Users\\Figmenta",
      ...fs({ [WIN_NPM]: "unknown", [WIN_NATIVE]: "2.1.284" }),
    });
    expect(resolution).toMatchObject({ status: "ready", path: WIN_NATIVE, version: "2.1.284" });
  });

  it("is too-old when every copy is below the minimum or does not start, and says which", async () => {
    const env = { ...WIN_ENV, Path: `C:\\Users\\Figmenta\\AppData\\Roaming\\npm;${WIN_ENV.Path}` };
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env,
      homedir: "C:\\Users\\Figmenta",
      ...fs({ [WIN_NPM]: "2.1.282", [WIN_NATIVE]: "broken" }),
    });
    expect(resolution).toEqual({
      status: "too-old",
      found: [
        { path: WIN_NPM, version: "2.1.282" },
        { path: WIN_NATIVE, version: null },
      ],
    });
  });

  it("is missing when there is no claude anywhere", async () => {
    const resolution = await resolveClaudeCode({
      platform: "win32",
      env: WIN_ENV,
      homedir: "C:\\Users\\Figmenta",
      ...fs({}),
    });
    expect(resolution).toEqual({ status: "missing" });
  });
});

describe("claudeCodeShim — the engine's private bin folder holds `claude` and nothing else", () => {
  it("macOS / Linux: a symlink named claude", () => {
    expect(
      claudeCodeShim(
        "darwin",
        "/Users/me/.local/bin/claude",
        "/Users/me/Library/Application Support/Orchestra/engine-bin",
      ),
    ).toEqual({
      kind: "symlink",
      file: "/Users/me/Library/Application Support/Orchestra/engine-bin/claude",
      target: "/Users/me/.local/bin/claude",
    });
  });

  it("Windows, claude.exe: a hard link named claude.exe (Paseo spawns it without a shell)", () => {
    const dir = "C:\\Users\\Figmenta\\AppData\\Local\\Orchestra\\engine-bin";
    expect(claudeCodeShim("win32", WIN_NATIVE, dir)).toEqual({
      kind: "hardlink",
      file: `${dir}\\claude.exe`,
      target: WIN_NATIVE,
    });
  });

  it("Windows, claude.cmd (npm): a .cmd calling it by absolute path, % escaped", () => {
    const dir = "C:\\x\\engine-bin";
    expect(claudeCodeShim("win32", WIN_NPM, dir)).toEqual({
      kind: "cmd",
      file: `${dir}\\claude.cmd`,
      target: WIN_NPM,
      content: `@"${WIN_NPM}" %*\r\n`,
    });
    const odd = "C:\\Users\\100%real\\npm\\claude.CMD";
    expect(claudeCodeShim("win32", odd, dir)).toMatchObject({
      kind: "cmd",
      content: '@"C:\\Users\\100%%real\\npm\\claude.CMD" %*\r\n',
    });
  });
});

describe("claudeCodeInstallerCommand", () => {
  it("Windows: install.ps1 for `latest` through PowerShell 5.1 by absolute path, no profile", () => {
    const env = {
      ...WIN_ENV,
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
      psmodulepath: "x",
    };
    const command = claudeCodeInstallerCommand("win32", env);
    expect(command.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(command.args.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    expect(command.args[5]).toContain("Invoke-RestMethod -Uri 'https://claude.ai/install.ps1'");
    expect(command.args[5]).toMatch(/\)\) latest$/);
    expect(command.args[5]).toContain("Tls12");
    // A PowerShell 7 PSModulePath breaks 5.1's Get-FileHash inside install.ps1 (measured).
    expect(Object.keys(command.env).some((key) => key.toLowerCase() === "psmodulepath")).toBe(
      false,
    );
    expect(command.env.Path).toBe(WIN_ENV.Path);
    expect(env.PSModulePath).toBeDefined();
  });

  it("Windows without SystemRoot falls back to C:\\Windows", () => {
    expect(claudeCodeInstallerCommand("win32", {}).command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("macOS: install.sh for `latest` over HTTPS and TLS 1.2+ only; a failed download fails the pipe", () => {
    const command = claudeCodeInstallerCommand("darwin", { PATH: "/usr/bin" });
    expect(command).toEqual({
      command: "/bin/bash",
      args: [
        "-c",
        "set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh | bash -s -- latest",
      ],
      env: { PATH: "/usr/bin" },
    });
  });

  it("asks for `latest`: the stable channel (2.1.277 on 2026-09-29) is below the minimum", () => {
    expect(CLAUDE_CODE_INSTALL_TARGET).toBe("latest");
  });
});

// ---------------------------------------------------------------------------
// The decision to install, with a fake installer and a fake screen
// ---------------------------------------------------------------------------

const READY: ClaudeCodeResolution = {
  status: "ready",
  path: WIN_NATIVE,
  version: "2.1.284",
  firstOnPath: false,
};

function harness(input: { resolutions: ClaudeCodeResolution[]; runs?: InstallerRun[] }) {
  const resolutions = [...input.resolutions];
  const runs = [...(input.runs ?? [])];
  const shown: SetupState[] = [];
  const screen: SetupScreen = { show: (state) => shown.push(state) };
  const deps = {
    resolve: vi.fn(async () => resolutions.shift() ?? { status: "missing" as const }),
    install: vi.fn(async () => runs.shift() ?? { ok: false, output: "no more runs" }),
    screen,
    log: vi.fn(),
  };
  return { deps, shown };
}

describe("ensureClaudeCode", () => {
  it("a good copy: nothing installed, nothing shown", async () => {
    const { deps, shown } = harness({ resolutions: [READY] });
    await expect(ensureClaudeCode(deps)).resolves.toEqual({
      status: "ready",
      resolution: READY,
      installed: false,
    });
    expect(deps.install).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
  });

  it("missing: installs once behind the screen, then uses what it finds", async () => {
    const { deps, shown } = harness({
      resolutions: [{ status: "missing" }, READY],
      runs: [{ ok: true, output: "Claude Code successfully installed!" }],
    });
    await expect(ensureClaudeCode(deps)).resolves.toEqual({
      status: "ready",
      resolution: READY,
      installed: true,
    });
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([{ phase: "installing", component: "claude-code", attempt: 1 }]);
  });

  it("too old: installs as well", async () => {
    const { deps } = harness({
      resolutions: [{ status: "too-old", found: [{ path: WIN_NPM, version: "2.1.200" }] }, READY],
      runs: [{ ok: true, output: "" }],
    });
    await expect(ensureClaudeCode(deps)).resolves.toMatchObject({
      status: "ready",
      installed: true,
    });
    expect(deps.install).toHaveBeenCalledTimes(1);
  });

  it("a failed install is returned with the reason, once: no wait, no second install", async () => {
    const { deps, shown } = harness({
      resolutions: [{ status: "missing" }, { status: "missing" }, READY],
      runs: [
        {
          ok: false,
          output: "Failed to get latest version: The remote name could not be resolved",
        },
        { ok: true, output: "ok" },
      ],
    });
    await expect(ensureClaudeCode(deps)).resolves.toEqual({
      status: "failed",
      failure: {
        component: "claude-code",
        message:
          "Claude Code could not be installed. Check your internet connection and try again.",
        detail: "Failed to get latest version: The remote name could not be resolved",
      },
    });
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([{ phase: "installing", component: "claude-code", attempt: 1 }]);
  });

  it("an installer stopped at its time limit says so", async () => {
    const { deps } = harness({
      resolutions: [{ status: "missing" }, { status: "missing" }],
      runs: [
        { ok: false, output: "Stopped: it did not finish within 10 minutes.", timedOut: true },
      ],
    });
    await expect(ensureClaudeCode(deps)).resolves.toMatchObject({
      status: "failed",
      failure: {
        message:
          "Claude Code could not be installed: the installer did not finish in time. Check your internet connection and try again.",
        detail: "Stopped: it did not finish within 10 minutes.",
      },
    });
  });

  it("a second attempt (Try again) says so on screen", async () => {
    const { deps, shown } = harness({
      resolutions: [{ status: "missing" }, READY],
      runs: [{ ok: true, output: "" }],
    });
    await ensureClaudeCode({ ...deps, attempt: 2 });
    expect(shown).toEqual([{ phase: "installing", component: "claude-code", attempt: 2 }]);
  });

  it("an installer that exits 0 but leaves nothing usable is a failure too", async () => {
    const { deps } = harness({
      resolutions: [{ status: "missing" }, { status: "missing" }],
      runs: [{ ok: true, output: "done" }],
    });
    await expect(ensureClaudeCode(deps)).resolves.toMatchObject({
      status: "failed",
      failure: { message: "Claude Code was installed, but Orchestra cannot find it." },
    });
  });

  it("still too old after installing: says so", async () => {
    const { deps } = harness({
      resolutions: [
        { status: "missing" },
        { status: "too-old", found: [{ path: WIN_NATIVE, version: "2.1.277" }] },
      ],
      runs: [{ ok: true, output: "" }],
    });
    await expect(ensureClaudeCode(deps)).resolves.toMatchObject({
      status: "failed",
      failure: {
        message: "Claude Code was installed, but the copy Orchestra finds is older than 2.1.283.",
      },
    });
  });

  it("a usable copy after a non-zero exit is taken: what counts is the copy", async () => {
    const { deps, shown } = harness({
      resolutions: [{ status: "missing" }, READY],
      runs: [{ ok: false, output: "warning, exit 1" }],
    });
    await expect(ensureClaudeCode(deps)).resolves.toMatchObject({
      status: "ready",
      installed: true,
    });
    expect(shown.map((state) => state.phase)).toEqual(["installing"]);
  });

  it("returns only the tail of a long installer output", async () => {
    const long = `${"x".repeat(2000)}THE END`;
    const { deps } = harness({
      resolutions: [{ status: "missing" }, { status: "missing" }],
      runs: [{ ok: false, output: long }],
    });
    const outcome = await ensureClaudeCode(deps);
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome.failure.detail.endsWith("THE END")).toBe(true);
    expect(outcome.failure.detail.length).toBeLessThanOrEqual(601);
  });
});

// ---------------------------------------------------------------------------
// 1.3.14: the requirement comes from the Claude model manifest
// ---------------------------------------------------------------------------

describe("requiredClaudeCodeVersion", () => {
  it("is the floor, or the highest minimum a Claude model asks for", () => {
    expect(requiredClaudeCodeVersion([])).toBe(MIN_CLAUDE_CODE_VERSION);
    expect(
      requiredClaudeCodeVersion([
        { id: "a", minimumClaudeCodeVersion: "2.1.100" },
        { id: "b" },
        { id: "c", minimumClaudeCodeVersion: "2.1.284" },
        { id: "d", minimumClaudeCodeVersion: "2.1.30" },
      ]),
    ).toBe("2.1.284");
    expect(
      requiredClaudeCodeVersion([{ id: "a", minimumClaudeCodeVersion: "2.1.9" }], "2.1.10"),
    ).toBe("2.1.10");
  });

  it("refuses a minimum that is not a version, rather than ignoring it", () => {
    expect(() =>
      requiredClaudeCodeVersion([{ id: "typo", minimumClaudeCodeVersion: "2.1.28x" }]),
    ).toThrow(/typo/);
  });

  it("covers every model of the manifest this build bundles: no model hidden by a lower copy", () => {
    const required = requiredClaudeCodeVersion(SOURCE_MANIFEST);
    for (const model of SOURCE_MANIFEST) {
      const minimum =
        "minimumClaudeCodeVersion" in model ? model.minimumClaudeCodeVersion : undefined;
      if (minimum === undefined) continue;
      const order = compareVersions(minimum, required);
      expect(order, `${model.id} needs ${minimum}, Orchestra requires ${required}`).not.toBe(1);
      expect(order).not.toBeNull();
    }
    expect(compareVersions(required, MIN_CLAUDE_CODE_VERSION)).not.toBe(-1);
  });

  it("the built server package the app imports agrees with the source manifest", () => {
    // A stale `packages/server/dist` would ship an older requirement: rebuild the server.
    expect(requiredClaudeCodeVersion(BUILT_MANIFEST)).toBe(
      requiredClaudeCodeVersion(SOURCE_MANIFEST),
    );
  });
});

// ---------------------------------------------------------------------------
// 1.3.14: the periodic check
// ---------------------------------------------------------------------------

describe("claudeCodeStatus / resolutionVersion", () => {
  const at = new Date("2026-10-08T16:00:00.000Z");

  it("is the shape window.orchestraDesktop.claudeCode has", () => {
    expect(claudeCodeStatus("2.1.294", "2.1.284", at)).toEqual({
      version: "2.1.294",
      required: "2.1.284",
      ok: true,
      checkedAt: "2026-10-08T16:00:00.000Z",
    });
    expect(claudeCodeStatus("2.1.283", "2.1.284", at).ok).toBe(false);
    expect(claudeCodeStatus(null, "2.1.284", at)).toMatchObject({ version: null, ok: false });
  });

  it("stands for the copy used, or the newest copy found too old", () => {
    expect(resolutionVersion({ status: "missing" })).toBeNull();
    expect(
      resolutionVersion({
        status: "ready",
        path: "/x/claude",
        version: "2.1.290",
        firstOnPath: true,
      }),
    ).toBe("2.1.290");
    expect(
      resolutionVersion({
        status: "too-old",
        found: [
          { path: "/a", version: "2.1.200" },
          { path: "/b", version: null },
          { path: "/c", version: "2.1.283" },
        ],
      }),
    ).toBe("2.1.283");
  });
});

describe("recheckClaudeCode", () => {
  const REQUIRED = "2.1.284";
  const SHIM = "/app/engine-bin/claude";
  const NATIVE = "/Users/giovanni/.local/bin/claude";
  const BREW = "/opt/homebrew/bin/claude";
  const ready = (path: string, version: string | null): ClaudeCodeResolution => ({
    status: "ready",
    path,
    version,
    firstOnPath: false,
  });
  const tooOld = (version: string): ClaudeCodeResolution => ({
    status: "too-old",
    found: [{ path: BREW, version }],
  });

  function deps(input: {
    engineCopy?: string | null;
    manage?: boolean;
    engineVersion?: ClaudeCodeVersionRead;
    resolutions?: ClaudeCodeResolution[];
    run?: InstallerRun;
    repointOk?: boolean;
  }) {
    const resolutions = [...(input.resolutions ?? [])];
    const d = {
      required: REQUIRED,
      engineCopy: input.engineCopy === undefined ? SHIM : input.engineCopy,
      manage: input.manage ?? true,
      readVersion: vi.fn(async () => input.engineVersion ?? "2.1.283"),
      resolve: vi.fn(async () => {
        const next = resolutions.shift();
        if (!next) throw new Error("unexpected resolve");
        return next;
      }),
      install: vi.fn(async () => input.run ?? { ok: true, output: "installed" }),
      repoint: vi.fn(() => input.repointOk ?? true),
      now: () => new Date("2026-10-08T16:30:00.000Z"),
      log: vi.fn(),
    } satisfies ClaudeCodeRecheckDeps;
    return d;
  }

  it("the engine's copy meets the requirement: nothing installed, nothing re-pointed", async () => {
    const d = deps({ engineVersion: "2.1.294" });
    const outcome = await recheckClaudeCode(d);
    expect(outcome).toEqual({
      action: "current",
      status: {
        version: "2.1.294",
        required: REQUIRED,
        ok: true,
        checkedAt: "2026-10-08T16:30:00.000Z",
      },
    });
    expect(d.readVersion).toHaveBeenCalledWith(SHIM);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(d.install).not.toHaveBeenCalled();
  });

  it("below the requirement: the official installer runs and new sessions get its copy", async () => {
    const d = deps({ resolutions: [tooOld("2.1.283"), ready(NATIVE, "2.1.294")] });
    const outcome = await recheckClaudeCode(d);
    expect(outcome).toMatchObject({
      action: "installed",
      path: NATIVE,
      status: { version: "2.1.294", ok: true },
    });
    expect(d.install).toHaveBeenCalledTimes(1);
    expect(d.repoint).toHaveBeenCalledWith(NATIVE);
  });

  it("an old Homebrew/npm copy next to a good native one: re-pointed, no install", async () => {
    // The native install leaves the package manager's copy where it is; resolve() (minimum =
    // required) skips the old one and returns the native copy.
    const d = deps({ resolutions: [ready(NATIVE, "2.1.294")] });
    const outcome = await recheckClaudeCode(d);
    expect(outcome).toMatchObject({ action: "repointed", path: NATIVE, status: { ok: true } });
    expect(d.install).not.toHaveBeenCalled();
    expect(d.repoint).toHaveBeenCalledWith(NATIVE);
  });

  it("a Windows link still on the replaced claude.exe: re-pointed at the new one", async () => {
    const d = deps({
      engineCopy: "C:\\Users\\G\\AppData\\Local\\Orchestra\\engine-bin\\claude.exe",
      engineVersion: "2.1.283",
      resolutions: [ready("C:\\Users\\G\\.local\\bin\\claude.exe", "2.1.294")],
    });
    await expect(recheckClaudeCode(d)).resolves.toMatchObject({ action: "repointed" });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("an installer that fails leaves the status as measured; the next check tries again", async () => {
    const d = deps({
      resolutions: [tooOld("2.1.283"), tooOld("2.1.283")],
      run: { ok: false, output: "offline" },
    });
    const outcome = await recheckClaudeCode(d);
    expect(outcome).toMatchObject({
      action: "failed",
      reason: "the installer failed",
      status: { version: "2.1.283", ok: false },
    });
    expect(d.repoint).not.toHaveBeenCalled();
  });

  it("a link that cannot be written is a failure, not a success", async () => {
    const d = deps({ resolutions: [ready(NATIVE, "2.1.294")], repointOk: false });
    const outcome = await recheckClaudeCode(d);
    expect(outcome).toMatchObject({ action: "failed", status: { version: "2.1.283", ok: false } });
  });

  it("a `--version` that is slow or unreadable is never reinstalled over", async () => {
    const d = deps({ engineVersion: "unknown" });
    await expect(recheckClaudeCode(d)).resolves.toMatchObject({
      action: "unreadable",
      status: { version: null, ok: false },
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("an engine copy that does not start is replaced", async () => {
    const d = deps({
      engineVersion: "broken",
      resolutions: [{ status: "missing" }, ready(NATIVE, "2.1.294")],
    });
    await expect(recheckClaudeCode(d)).resolves.toMatchObject({ action: "installed" });
  });

  it("no link yet (the setup at launch failed): installed and linked", async () => {
    const d = deps({
      engineCopy: null,
      resolutions: [{ status: "missing" }, ready(NATIVE, "2.1.294")],
    });
    await expect(recheckClaudeCode(d)).resolves.toMatchObject({
      action: "installed",
      path: NATIVE,
    });
    expect(d.readVersion).not.toHaveBeenCalled();
  });

  it("an engine Orchestra did not launch is measured and never changed", async () => {
    const reused = deps({ engineCopy: null, manage: false, resolutions: [tooOld("2.1.283")] });
    await expect(recheckClaudeCode(reused)).resolves.toMatchObject({
      action: "report-only",
      status: { version: "2.1.283", ok: false },
    });
    expect(reused.install).not.toHaveBeenCalled();
    expect(reused.repoint).not.toHaveBeenCalled();

    const measureOnly = deps({ manage: false, engineVersion: "2.1.200" });
    await expect(recheckClaudeCode(measureOnly)).resolves.toMatchObject({
      action: "report-only",
      status: { version: "2.1.200", ok: false },
    });
    expect(measureOnly.resolve).not.toHaveBeenCalled();
  });
});
