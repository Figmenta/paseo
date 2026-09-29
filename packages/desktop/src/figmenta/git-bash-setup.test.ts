import { describe, expect, it, vi } from "vitest";
import type { InstallerRun, SetupScreen, SetupState } from "./claude-code-setup.js";
import {
  BUNDLED_GIT_READY_MARKER,
  bundledGitLayout,
  ensureGitBash,
  GIT_BASH_ENV,
  portableGitExtractArgs,
  resolveSystemGitBash,
  withGitBash,
  type BundledGitLayout,
  type GitBashResolution,
} from "./git-bash-setup.js";

const ENV = {
  Path: "C:\\Windows\\system32;C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\Anna Rossi\\AppData\\Local",
};
const PROGRAM_FILES_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

function existing(...files: string[]) {
  return (file: string) => files.includes(file);
}

describe("resolveSystemGitBash", () => {
  it("a clean Windows has none", () => {
    expect(resolveSystemGitBash({ env: ENV, exists: existing() })).toEqual({ status: "absent" });
  });

  it("a Git for Windows on PATH: Claude Code finds <git.exe folder>\\..\\bin\\bash.exe itself", () => {
    const env = { ...ENV, Path: `${ENV.Path};C:\\Program Files\\Git\\cmd` };
    const exists = existing("C:\\Program Files\\Git\\cmd\\git.exe", PROGRAM_FILES_BASH);
    expect(resolveSystemGitBash({ env, exists })).toEqual({
      status: "found",
      bashPath: PROGRAM_FILES_BASH,
      seenByClaudeCode: true,
    });
  });

  it("MinGit on PATH does not count: no bin\\bash.exe next to its cmd (measured)", () => {
    const env = { ...ENV, Path: `C:\\MinGit\\cmd;${ENV.Path}` };
    const exists = existing("C:\\MinGit\\cmd\\git.exe", "C:\\MinGit\\usr\\bin\\sh.exe");
    expect(resolveSystemGitBash({ env, exists })).toEqual({ status: "absent" });
  });

  it("an installed Git off PATH is named explicitly", () => {
    expect(resolveSystemGitBash({ env: ENV, exists: existing(PROGRAM_FILES_BASH) })).toEqual({
      status: "found",
      bashPath: PROGRAM_FILES_BASH,
      seenByClaudeCode: false,
    });
    const perUser = "C:\\Users\\Anna Rossi\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(resolveSystemGitBash({ env: ENV, exists: existing(perUser) })).toEqual({
      status: "found",
      bashPath: perUser,
      seenByClaudeCode: false,
    });
  });

  it("honours a CLAUDE_CODE_GIT_BASH_PATH that exists", () => {
    const env = { ...ENV, [GIT_BASH_ENV]: "D:\\tools\\bash.exe" };
    expect(resolveSystemGitBash({ env, exists: existing("D:\\tools\\bash.exe") })).toEqual({
      status: "found",
      bashPath: "D:\\tools\\bash.exe",
      seenByClaudeCode: true,
    });
  });

  it("a CLAUDE_CODE_GIT_BASH_PATH that does not exist makes the real one explicit", () => {
    const env = {
      ...ENV,
      claude_code_git_bash_path: "D:\\gone\\bash.exe",
      Path: `${ENV.Path};C:\\Program Files\\Git\\cmd`,
    };
    const exists = existing("C:\\Program Files\\Git\\cmd\\git.exe", PROGRAM_FILES_BASH);
    expect(resolveSystemGitBash({ env, exists })).toEqual({
      status: "found",
      bashPath: PROGRAM_FILES_BASH,
      seenByClaudeCode: false,
    });
  });
});

describe("the bundled PortableGit", () => {
  const archive =
    "C:\\Users\\Anna Rossi\\AppData\\Local\\Programs\\Orchestra\\resources\\git\\PortableGit-2.56.0-64-bit.7z.exe";

  it("unpacks per user under %LOCALAPPDATA%\\Orchestra\\git\\<version>, with the pinned hash", () => {
    const dir = "C:\\Users\\Anna Rossi\\AppData\\Local\\Orchestra\\git\\PortableGit-2.56.0-64-bit";
    expect(bundledGitLayout(archive, "ECEB5E06", ENV.LOCALAPPDATA)).toEqual({
      archive,
      sha256: "eceb5e06",
      dir,
      bashPath: `${dir}\\bin\\bash.exe`,
      cmdDir: `${dir}\\cmd`,
      marker: `${dir}\\${BUNDLED_GIT_READY_MARKER}`,
    });
  });

  it("names the quoted target folder FIRST: after -gm2 the extractor ignores -o (measured)", () => {
    expect(portableGitExtractArgs("C:\\a b\\git")).toEqual(['-o"C:\\a b\\git"', "-y", "-gm2"]);
  });
});

describe("withGitBash", () => {
  it("names the bash and replaces any other spelling of the variable", () => {
    const env = { Path: "C:\\x", claude_code_git_bash_path: "D:\\gone\\bash.exe" };
    expect(withGitBash(env, "C:\\g\\bin\\bash.exe", null)).toEqual({
      Path: "C:\\x",
      [GIT_BASH_ENV]: "C:\\g\\bin\\bash.exe",
    });
  });

  it("appends Orchestra's git to the END of PATH, never ahead of the user's tools", () => {
    expect(withGitBash({ Path: "C:\\x;C:\\y" }, "C:\\g\\bin\\bash.exe", "C:\\g\\cmd")).toEqual({
      Path: "C:\\x;C:\\y;C:\\g\\cmd",
      [GIT_BASH_ENV]: "C:\\g\\bin\\bash.exe",
    });
    expect(withGitBash({}, "C:\\g\\bin\\bash.exe", "C:\\g\\cmd")).toEqual({
      Path: "C:\\g\\cmd",
      [GIT_BASH_ENV]: "C:\\g\\bin\\bash.exe",
    });
  });

  it("does not modify the environment it is given", () => {
    const env = { Path: "C:\\x" };
    withGitBash(env, "C:\\g\\bin\\bash.exe", "C:\\g\\cmd");
    expect(env).toEqual({ Path: "C:\\x" });
  });
});

// ---------------------------------------------------------------------------
// The decision to unpack, with a fake extractor and a fake screen
// ---------------------------------------------------------------------------

const LAYOUT: BundledGitLayout = bundledGitLayout(
  "C:\\Orchestra\\resources\\git\\PortableGit-2.56.0-64-bit.7z.exe",
  "eceb5e061aa90df2f69ddd3e90f0030e1b8037a7829934bc40e4be1caa1accc1",
  "C:\\Users\\Anna\\AppData\\Local",
);

function harness(input: {
  system?: GitBashResolution;
  bundled?: BundledGitLayout | null;
  files?: string[];
  unpacks?: { run: InstallerRun; creates: string[] }[];
}) {
  const files = new Set(input.files ?? []);
  const unpacks = [...(input.unpacks ?? [])];
  const shown: SetupState[] = [];
  const screen: SetupScreen = { show: (state) => shown.push(state) };
  const deps = {
    resolveSystem: () => input.system ?? { status: "absent" as const },
    bundled: () => (input.bundled === undefined ? LAYOUT : input.bundled),
    exists: (file: string) => files.has(file),
    unpack: vi.fn(async () => {
      const next = unpacks.shift() ?? { run: { ok: false, output: "no more" }, creates: [] };
      for (const file of next.creates) files.add(file);
      return next.run;
    }),
    screen,
    log: vi.fn(),
  };
  return { deps, shown };
}

describe("ensureGitBash", () => {
  it("the machine's own Git Bash wins; nothing unpacked, nothing shown", async () => {
    const { deps, shown } = harness({
      system: { status: "found", bashPath: PROGRAM_FILES_BASH, seenByClaudeCode: true },
    });
    await expect(ensureGitBash(deps)).resolves.toEqual({
      status: "system",
      bashPath: PROGRAM_FILES_BASH,
      explicit: false,
    });
    expect(deps.unpack).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
  });

  it("a Git off PATH is passed explicitly", async () => {
    const { deps } = harness({
      system: { status: "found", bashPath: PROGRAM_FILES_BASH, seenByClaudeCode: false },
    });
    await expect(ensureGitBash(deps)).resolves.toMatchObject({ status: "system", explicit: true });
  });

  it("already unpacked by an earlier run: used as is", async () => {
    const { deps, shown } = harness({ files: [LAYOUT.marker, LAYOUT.bashPath] });
    await expect(ensureGitBash(deps)).resolves.toEqual({
      status: "bundled",
      layout: LAYOUT,
      unpacked: false,
    });
    expect(deps.unpack).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
  });

  it("a half-unpacked folder (bash.exe but no marker) is unpacked again", async () => {
    const { deps } = harness({
      files: [LAYOUT.bashPath],
      unpacks: [{ run: { ok: true, output: "" }, creates: [LAYOUT.marker] }],
    });
    await expect(ensureGitBash(deps)).resolves.toMatchObject({ status: "bundled", unpacked: true });
    expect(deps.unpack).toHaveBeenCalledTimes(1);
  });

  it("first run on a clean Windows: unpacks behind the screen", async () => {
    const { deps, shown } = harness({
      unpacks: [{ run: { ok: true, output: "" }, creates: [LAYOUT.marker, LAYOUT.bashPath] }],
    });
    await expect(ensureGitBash(deps)).resolves.toEqual({
      status: "bundled",
      layout: LAYOUT,
      unpacked: true,
    });
    expect(shown).toEqual([{ phase: "installing", component: "git-bash", attempt: 1 }]);
  });

  it("an unpack that leaves no bash.exe fails once and says why; it is not retried by itself", async () => {
    const { deps, shown } = harness({
      unpacks: [
        { run: { ok: false, output: "There is not enough space on the disk." }, creates: [] },
        { run: { ok: true, output: "" }, creates: [LAYOUT.marker, LAYOUT.bashPath] },
      ],
    });
    await expect(ensureGitBash(deps)).resolves.toEqual({
      status: "failed",
      failure: {
        component: "git-bash",
        message:
          "Git Bash, which Claude Code needs on Windows, could not be unpacked. Check that the disk has 500 MB free and try again.",
        detail: "There is not enough space on the disk.",
      },
    });
    expect(shown).toEqual([{ phase: "installing", component: "git-bash", attempt: 1 }]);
    expect(deps.unpack).toHaveBeenCalledTimes(1);
  });

  it("a second attempt (Try again) says so on screen", async () => {
    const { deps, shown } = harness({
      unpacks: [{ run: { ok: true, output: "" }, creates: [LAYOUT.marker, LAYOUT.bashPath] }],
    });
    await expect(ensureGitBash({ ...deps, attempt: 2 })).resolves.toMatchObject({
      status: "bundled",
    });
    expect(shown).toEqual([{ phase: "installing", component: "git-bash", attempt: 2 }]);
  });

  it("an unpack that knows better (a damaged archive) says so instead of the disk space hint", async () => {
    const { deps } = harness({
      unpacks: [
        {
          run: {
            ok: false,
            output: "x.7z.exe has SHA-256 aa, expected bb: not unpacked.",
            message:
              "Orchestra's copy of Git Bash is damaged and was not used. Reinstall Orchestra.",
          },
          creates: [],
        },
      ],
    });
    await expect(ensureGitBash(deps)).resolves.toMatchObject({
      status: "failed",
      failure: {
        message: "Orchestra's copy of Git Bash is damaged and was not used. Reinstall Orchestra.",
        detail: "x.7z.exe has SHA-256 aa, expected bb: not unpacked.",
      },
    });
  });

  it("an unpack stopped at its time limit says so", async () => {
    const { deps } = harness({
      unpacks: [{ run: { ok: false, output: "Stopped", timedOut: true }, creates: [] }],
    });
    await expect(ensureGitBash(deps)).resolves.toMatchObject({
      status: "failed",
      failure: {
        message:
          "Git Bash, which Claude Code needs on Windows, could not be unpacked in time. Try again.",
      },
    });
  });

  it("an exit code 0 without the marker is still a failure", async () => {
    const { deps } = harness({
      unpacks: [{ run: { ok: true, output: "" }, creates: [LAYOUT.bashPath] }],
    });
    await expect(ensureGitBash(deps)).resolves.toMatchObject({ status: "failed" });
  });

  it("no Git anywhere and none bundled (a development run): unavailable, nothing shown", async () => {
    const { deps, shown } = harness({ bundled: null });
    await expect(ensureGitBash(deps)).resolves.toEqual({ status: "unavailable" });
    expect(shown).toEqual([]);
  });
});
