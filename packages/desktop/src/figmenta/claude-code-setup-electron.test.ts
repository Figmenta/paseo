import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_MODEL_MANIFEST } from "../../../server/src/server/agent/providers/claude/model-manifest.js";
import { compareVersions } from "./semver.js";

// Figmenta fork: the Electron side of the engine setup (claude-code-setup-electron.ts), with real
// processes on this machine and a fake Electron. What it pins (T-3083 block 5, review round):
//  - the installer's time limit holds: the whole process tree is killed, and the run is over when
//    the installer EXITS, even if a child it left behind holds its output open;
//  - closing the setup window stops the install and never quits: the engine gets the app's own
//    environment, Orchestra opens, "Try again" stays (window, then File menu) and restarts the engine;
//  - the engine's PATH gets a private folder holding only `claude`, never Claude Code's own folder;
//  - a slow or unreadable `--version` is "present, version unknown", never a reinstall;
//  - PortableGit is checked against its SHA-256 before it is run;
//  - quitting the app leaves no installer process behind.
// POSIX only: the Windows side (taskkill /T, the hard link) is measured on windows-latest.

const electron = vi.hoisted(() => {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    listeners,
    userData: "",
    quit: (() => {}) as () => void,
    handlers: new Map<string, (event: { sender: unknown }) => unknown>(),
    onHandlers: new Map<string, (event: { sender: unknown; returnValue?: unknown }) => void>(),
    power: new Map<string, () => void>(),
  };
});

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly send = vi.fn();
  setWindowOpenHandler(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  static getAllWindows(): FakeWindow[] {
    return FakeWindow.all.filter((win) => !win.destroyed);
  }
  static getFocusedWindow(): FakeWindow | null {
    return null;
  }
  destroyed = false;
  visible = false;
  parent: FakeWindow | null;
  readonly webContents = new FakeWebContents();
  constructor(readonly options: { parent?: FakeWindow } = {}) {
    super();
    this.parent = options.parent ?? null;
    FakeWindow.all.push(this);
  }
  removeMenu(): void {}
  loadURL(): Promise<void> {
    queueMicrotask(() => {
      this.emit("ready-to-show");
      this.webContents.emit("did-finish-load");
    });
    return Promise.resolve();
  }
  show(): void {
    this.visible = true;
  }
  focus(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  setParentWindow(parent: FakeWindow | null): void {
    this.parent = parent;
  }
  /** Whoever calls it: the app on purpose, or the test standing in for the user. */
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      electron.listeners.set(event, [...(electron.listeners.get(event) ?? []), listener]);
    },
    quit: () => electron.quit(),
    isPackaged: false,
    getPath: () => electron.userData,
  },
  BrowserWindow: FakeWindow,
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: unknown }) => unknown) =>
      electron.handlers.set(channel, handler),
    on: (channel: string, handler: (event: { sender: unknown }) => void) =>
      electron.onHandlers.set(channel, handler),
  },
  powerMonitor: {
    on: (event: string, listener: () => void) => electron.power.set(event, listener),
  },
}));

vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real resolution, confined to this test's folders (a real claude on this machine is not
// the test's business), and a fake official installer.
const fake = vi.hoisted(() => ({
  root: "",
  installer: "exit 1",
  installs: 0,
  targets: [] as string[],
}));
vi.mock("./claude-code-setup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./claude-code-setup.js")>();
  return {
    ...real,
    resolveClaudeCode: (input: Parameters<typeof real.resolveClaudeCode>[0]) =>
      real.resolveClaudeCode({
        ...input,
        exists: (file) => file.startsWith(fake.root) && input.exists(file),
      }),
    claudeCodeInstallerCommand: (
      platform: NodeJS.Platform,
      env: Record<string, string>,
      target?: string,
    ) => {
      // The real one validates the target: what reaches it is what the installer would get.
      real.claudeCodeInstallerCommand(platform, env, target);
      fake.installs += 1;
      fake.targets.push(target ?? real.CLAUDE_CODE_INSTALL_TARGET);
      return { command: "/bin/sh", args: ["-c", fake.installer], env };
    },
  };
});

const setup = await import("./claude-code-setup-electron.js");
const { getBundledCliShimPath } = await import("../integrations/cli-install/paths.js");
const log = (await import("electron-log/main")).default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let root: string;
let home: string;
let pidFile: string;
let baseEnv: NodeJS.ProcessEnv;
let quit: ReturnType<typeof vi.fn>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs a fake installer wrote down: itself ($$) and the child it left running ($!). */
function recordedPids(): number[] {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, "utf8").split(/\s+/).filter(Boolean).map(Number);
}

async function allDead(pids: number[], withinMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (pids.some(alive) && Date.now() < deadline) await sleep(50);
  return !pids.some(alive);
}

async function until(check: () => boolean, withinMs = 5_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

const HANG = (file: string) => `sleep 30 & echo $$ $! > "${file}"; echo "downloading..."; sleep 30`;

function writeClaude(dir: string, body = 'echo "2.1.290 (Claude Code)"', mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

/** The official installer, as far as Orchestra can tell: a `claude` in ~/.local/bin afterwards. */
function installerThatInstalls(): string {
  const dir = path.join(home, ".local", "bin");
  return `mkdir -p "${dir}" && printf '#!/bin/sh\\necho "2.1.290 (Claude Code)"\\n' > "${dir}/claude" && chmod +x "${dir}/claude" && echo "Claude Code successfully installed!"`;
}

function openSetupWindow(): FakeWindow | null {
  return FakeWindow.getAllWindows().find((win) => win !== mainWindow) ?? null;
}

async function screenOf(win: FakeWindow): Promise<Record<string, unknown> | null> {
  const handler = electron.handlers.get("orchestra-setup:get-state");
  return (await handler?.({ sender: win.webContents })) as Record<string, unknown> | null;
}

let mainWindow: FakeWindow | null = null;

beforeEach(() => {
  setup.__resetEngineSetup();
  FakeWindow.all = [];
  mainWindow = null;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "orchestra-engine-setup-")));
  home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  pidFile = path.join(root, "pids");
  electron.userData = path.join(root, "userData");
  fake.root = root;
  fake.installer = "exit 1";
  fake.installs = 0;
  fake.targets = [];
  // Never the real network: the newest version is unknown unless a test says otherwise.
  setup.__setLatestClaudeCodeSource(async () => {
    throw new Error("offline (test)");
  });
  vi.mocked(log.info).mockClear();
  quit = vi.fn();
  electron.quit = quit;
  vi.stubEnv("HOME", home);
  vi.stubEnv(setup.SETUP_TIMEOUT_ENV, "");
  baseEnv = { PATH: "/usr/bin:/bin", HOME: home };
});

afterEach(() => {
  for (const pid of recordedPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  setup.__resetEngineSetup();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runProcess: the time limit holds, and nothing is left behind
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("runProcess", () => {
  it("past its time limit the installer is killed with every process it started", async () => {
    const started = Date.now();
    const run = await setup.runProcess("/bin/sh", ["-c", HANG(pidFile)], {
      env: baseEnv,
      timeoutMs: 400,
    });
    // SIGTERM reaches the whole group at once: no wait for the SIGKILL fallback (3 s later).
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(run).toMatchObject({ ok: false, timedOut: true, cancelled: false });
    expect(run.output).toContain("downloading...");
    expect(run.output).toContain("Stopped: it did not finish within 400 ms.");
    const pids = recordedPids();
    expect(pids).toHaveLength(2);
    expect(await allDead(pids)).toBe(true);
  });

  it("a tree that ignores SIGTERM gets SIGKILL after the grace period", async () => {
    const run = await setup.runProcess("/bin/sh", ["-c", `trap "" TERM; ${HANG(pidFile)}`], {
      env: baseEnv,
      timeoutMs: 300,
    });
    expect(run.timedOut).toBe(true);
    expect(await allDead(recordedPids())).toBe(true);
  }, 15_000);

  it("the run is over when the installer exits, even if a child it left holds its output open", async () => {
    const started = Date.now();
    const run = await setup.runProcess(
      "/bin/sh",
      ["-c", `sleep 30 & echo $! > "${pidFile}"; echo "installed"; exit 0`],
      { env: baseEnv, timeoutMs: 60_000 },
    );
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(run).toMatchObject({ ok: true, timedOut: false });
    expect(run.output).toContain("installed");
  }, 10_000);

  it("an abort (the setup window closed) kills the tree at once", async () => {
    const abort = new AbortController();
    const pending = setup.runProcess("/bin/sh", ["-c", HANG(pidFile)], {
      env: baseEnv,
      timeoutMs: 60_000,
      signal: abort.signal,
    });
    await until(() => recordedPids().length === 2);
    const abortedAt = Date.now();
    abort.abort();
    const run = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(2_500);
    expect(run).toMatchObject({ ok: false, cancelled: true, timedOut: false });
    expect(run.output).toContain("Stopped: the setup window was closed.");
    expect(await allDead(recordedPids())).toBe(true);
  });

  it("a command that cannot start is reported as such", async () => {
    const run = await setup.runProcess(path.join(root, "no-such-claude"), ["--version"], {
      env: baseEnv,
      timeoutMs: 5_000,
    });
    expect(run).toMatchObject({ ok: false, spawnFailed: true });
  });

  it("the time limit can be shortened for a test run, and only to a positive integer", () => {
    expect(setup.installTimeoutMs({})).toBe(600_000);
    expect(setup.installTimeoutMs({ [setup.SETUP_TIMEOUT_ENV]: "15000" })).toBe(15_000);
    expect(setup.installTimeoutMs({ [setup.SETUP_TIMEOUT_ENV]: "0" })).toBe(600_000);
    expect(setup.installTimeoutMs({ [setup.SETUP_TIMEOUT_ENV]: "soon" })).toBe(600_000);
  });

  it("quitting the app kills an installer still running, with its children", async () => {
    const pending = setup.runProcess("/bin/sh", ["-c", HANG(pidFile)], {
      env: baseEnv,
      timeoutMs: 60_000,
    });
    await until(() => recordedPids().length === 2);
    for (const listener of electron.listeners.get("before-quit") ?? []) listener();
    expect(await allDead(recordedPids())).toBe(true);
    await pending;
  });
});

// ---------------------------------------------------------------------------
// prepareEngineEnvironment: Orchestra always opens
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("prepareEngineEnvironment", () => {
  const binDir = () => path.join(electron.userData, "engine-bin");

  it("Claude Code already there: nothing shown; PATH gets a private folder with only `claude` in it", async () => {
    const local = path.join(home, ".local", "bin");
    const claude = writeClaude(local);
    writeFileSync(path.join(local, "uv"), "#!/bin/sh\n"); // must not shadow the user's own uv

    const env = await setup.prepareEngineEnvironment(baseEnv);

    expect(env.PATH).toBe(`${binDir()}:/usr/bin:/bin`);
    expect(readdirSync(binDir())).toEqual(["claude"]);
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(claude);
    expect(env.PATH).not.toContain(local);
    expect(fake.installs).toBe(0);
    expect(FakeWindow.all).toEqual([]);
    expect(setup.engineSetupStatus()).toBe("ready");
  });

  it("the first `claude` on PATH is good: still linked from the private folder, so it can be re-pointed", async () => {
    const local = path.join(home, ".local", "bin");
    const claude = writeClaude(local);
    const env = await setup.prepareEngineEnvironment({ ...baseEnv, PATH: `${local}:/usr/bin` });
    expect(env.PATH).toBe(`${binDir()}:${local}:/usr/bin`);
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(claude);
  });

  it("the private folder is renewed: anything else in it goes, the link follows the new copy", async () => {
    mkdirSync(binDir(), { recursive: true });
    writeFileSync(path.join(binDir(), "claude.cmd"), "stale");
    writeFileSync(path.join(binDir(), "node"), "stale");
    const claude = writeClaude(path.join(home, ".claude", "local"));

    await setup.prepareEngineEnvironment(baseEnv);

    expect(readdirSync(binDir())).toEqual(["claude"]);
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(claude);
  });

  it("a `--version` that says nothing readable is used as is, never reinstalled over", async () => {
    const claude = writeClaude(path.join(home, ".local", "bin"), 'echo "hello"');
    const env = await setup.prepareEngineEnvironment(baseEnv);
    expect(fake.installs).toBe(0);
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(claude);
    expect(env.PATH?.startsWith(binDir())).toBe(true);
  });

  it("a `claude` that does not start is reinstalled", async () => {
    writeClaude(path.join(home, ".local", "bin"), 'echo "2.1.290 (Claude Code)"', 0o644);
    fake.installer = installerThatInstalls();
    const env = await setup.prepareEngineEnvironment(baseEnv);
    expect(fake.installs).toBe(1);
    expect(env.PATH?.startsWith(binDir())).toBe(true);
  });

  it("missing: installed behind the window, which goes once Orchestra's window exists", async () => {
    fake.installer = installerThatInstalls();
    const env = await setup.prepareEngineEnvironment(baseEnv);

    expect(fake.installs).toBe(1);
    expect(env.PATH?.startsWith(binDir())).toBe(true);
    const win = openSetupWindow()!;
    expect(await screenOf(win)).toEqual({ phase: "starting", restart: false });

    mainWindow = new FakeWindow();
    setup.finishEngineSetup();
    expect(win.isDestroyed()).toBe(true);
    expect(quit).not.toHaveBeenCalled();
  });

  it("install fails: the engine gets the app's own env, the window says why and stays in front, nothing quits", async () => {
    const statusChanges = vi.fn();
    setup.registerEngineSetup({ restartEngine: vi.fn(), onStatusChange: statusChanges });
    fake.installer = 'echo "curl: (6) Could not resolve host: claude.ai" >&2; exit 6';

    const env = await setup.prepareEngineEnvironment(baseEnv);

    // The app's own env, plus the private folder, empty: a later background install links there.
    expect(env).toEqual({
      ...baseEnv,
      PATH: `${binDir()}:${baseEnv.PATH}`,
      ORCHESTRA_ENGINE_BIN: binDir(),
    });
    expect(readdirSync(binDir())).toEqual([]);
    expect(setup.engineSetupStatus()).toBe("failed");
    expect(statusChanges).toHaveBeenCalled();
    const win = openSetupWindow()!;
    expect(await screenOf(win)).toEqual({
      phase: "failed",
      component: "claude-code",
      message: "Claude Code could not be installed. Check your internet connection and try again.",
      detail: "curl: (6) Could not resolve host: claude.ai",
    });

    // Orchestra's window opens (main.ts): the failure stays in front of it, as its dialog.
    mainWindow = new FakeWindow();
    setup.finishEngineSetup();
    expect(win.isDestroyed()).toBe(false);
    expect(win.parent).toBe(mainWindow);
    expect(win.visible).toBe(true);

    // The user closes it: "not now". Orchestra goes on.
    win.close();
    expect(quit).not.toHaveBeenCalled();
    expect(setup.engineSetupStatus()).toBe("failed"); // the File menu keeps "Set Up Claude Code…"
  });

  it("closing the setup window while installing stops the installer tree; the engine starts without it", async () => {
    fake.installer = HANG(pidFile);
    const pending = setup.prepareEngineEnvironment(baseEnv);
    await until(() => recordedPids().length === 2 && openSetupWindow() !== null);
    const win = openSetupWindow()!;
    expect(await screenOf(win)).toEqual({
      phase: "installing",
      component: "claude-code",
      attempt: 1,
    });

    const closedAt = Date.now();
    win.close();
    const env = await pending;

    expect(Date.now() - closedAt).toBeLessThan(5_000);
    expect(env).toEqual({
      ...baseEnv,
      PATH: `${binDir()}:${baseEnv.PATH}`,
      ORCHESTRA_ENGINE_BIN: binDir(),
    });
    expect(await allDead(recordedPids())).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    expect(FakeWindow.getAllWindows()).toEqual([]); // not reopened with the failure
    expect(setup.engineSetupStatus()).toBe("failed");
  });

  it("an installer that hangs is stopped at the time limit, with its children; the engine starts without it", async () => {
    vi.stubEnv(setup.SETUP_TIMEOUT_ENV, "500");
    fake.installer = HANG(pidFile);

    const started = Date.now();
    const env = await setup.prepareEngineEnvironment(baseEnv);

    expect(Date.now() - started).toBeLessThan(6_000);
    expect(env).toEqual({
      ...baseEnv,
      PATH: `${binDir()}:${baseEnv.PATH}`,
      ORCHESTRA_ENGINE_BIN: binDir(),
    });
    expect(await allDead(recordedPids())).toBe(true);
    const state = await screenOf(openSetupWindow()!);
    expect(state).toMatchObject({
      phase: "failed",
      message:
        "Claude Code could not be installed: the installer did not finish in time. Check your internet connection and try again.",
    });
    expect(String(state?.detail)).toContain("Stopped: it did not finish within 500 ms.");
    expect(quit).not.toHaveBeenCalled();
  });

  it("Try again after a failure: installs, restarts the engine, closes the window", async () => {
    const restarts: NodeJS.ProcessEnv[] = [];
    const statusChanges = vi.fn();
    setup.registerEngineSetup({
      // As main.ts does: stop our engine and start it again, which prepares its env again.
      restartEngine: async () => {
        restarts.push(await setup.prepareEngineEnvironment(baseEnv));
      },
      onStatusChange: statusChanges,
    });
    await setup.prepareEngineEnvironment(baseEnv); // fails: exit 1
    mainWindow = new FakeWindow();
    setup.finishEngineSetup();
    const win = openSetupWindow()!;
    expect(setup.engineSetupStatus()).toBe("failed");

    fake.installer = installerThatInstalls();
    electron.onHandlers.get("orchestra-setup:retry")?.({ sender: win.webContents });
    await until(() => win.isDestroyed());

    expect(fake.installs).toBe(2);
    expect(restarts).toHaveLength(1);
    expect(restarts[0].PATH?.startsWith(binDir())).toBe(true);
    expect(setup.engineSetupStatus()).toBe("ready");
    expect(statusChanges).toHaveBeenCalledTimes(2); // failed, then ready: the menu item goes
    expect(quit).not.toHaveBeenCalled();
  });

  it("Try again from the File menu once the window is closed: the window comes back for the attempt", async () => {
    const restartEngine = vi.fn(async () => {});
    setup.registerEngineSetup({ restartEngine });
    await setup.prepareEngineEnvironment(baseEnv); // fails
    mainWindow = new FakeWindow();
    openSetupWindow()!.close();

    fake.installer = 'sleep 1; echo "still offline" >&2; exit 7';
    const shown: unknown[] = [];
    const retry = setup.retryEngineSetup();
    await until(() => openSetupWindow() !== null);
    shown.push(await screenOf(openSetupWindow()!));
    await retry;
    expect(shown).toEqual([{ phase: "installing", component: "claude-code", attempt: 2 }]);

    const win = openSetupWindow()!;
    expect(win.parent).toBe(mainWindow);
    expect(await screenOf(win)).toMatchObject({ phase: "failed", detail: "still offline" });
    expect(restartEngine).not.toHaveBeenCalled();
    expect(setup.engineSetupStatus()).toBe("failed");
  });

  it("a retry that installs but cannot restart the engine says so and keeps Try again", async () => {
    setup.registerEngineSetup({
      restartEngine: async () => {
        throw new Error("daemon did not stop");
      },
    });
    await setup.prepareEngineEnvironment(baseEnv); // fails
    fake.installer = installerThatInstalls();
    await setup.retryEngineSetup();
    expect(await screenOf(openSetupWindow()!)).toMatchObject({
      phase: "failed",
      message:
        "Claude Code is ready, but the engine did not restart. Quit Orchestra and open it again.",
      detail: "daemon did not stop",
    });
  });
});

// ---------------------------------------------------------------------------
// 1.3.14: the requirement, the periodic check, and what the Orchestra page is told
// ---------------------------------------------------------------------------

describe("REQUIRED_CLAUDE_CODE_VERSION", () => {
  it("no Claude model of the manifest needs more than what the app requires", () => {
    for (const model of CLAUDE_MODEL_MANIFEST) {
      const minimum =
        "minimumClaudeCodeVersion" in model ? model.minimumClaudeCodeVersion : undefined;
      if (minimum === undefined) continue;
      expect(
        compareVersions(minimum, setup.REQUIRED_CLAUDE_CODE_VERSION),
        `${model.id} needs Claude Code ${minimum}, the app requires ${setup.REQUIRED_CLAUDE_CODE_VERSION}`,
      ).not.toBe(1);
    }
  });
});

describe.skipIf(process.platform === "win32")("periodic Claude Code check", () => {
  const binDir = () => path.join(electron.userData, "engine-bin");
  const local = () => path.join(home, ".local", "bin");
  const pageStatus = () => {
    const event: { sender: unknown; returnValue?: unknown } = { sender: null };
    electron.onHandlers.get(setup.CLAUDE_CODE_STATUS_GET_CHANNEL)?.(event);
    return event.returnValue as Record<string, unknown> | null;
  };

  it("at launch the setup's own measurement is what the page reads", async () => {
    writeClaude(local(), 'echo "2.1.290 (Claude Code)"');
    await setup.prepareEngineEnvironment(baseEnv);
    await setup.startClaudeCodeWatch();
    expect(pageStatus()).toMatchObject({ version: "2.1.290", required: "2.1.284", ok: true });
    expect(new Date(String(pageStatus()?.checkedAt)).toISOString()).toBe(pageStatus()?.checkedAt);
    expect(fake.installs).toBe(0);
  });

  it("below the requirement while the engine runs: installed in the background, link followed, catalog read again, page told", async () => {
    const refreshClaudeCatalog = vi.fn(async () => {});
    setup.registerEngineSetup({ restartEngine: vi.fn(), refreshClaudeCatalog });
    writeClaude(local(), 'echo "2.1.290 (Claude Code)"');
    await setup.prepareEngineEnvironment(baseEnv);
    await setup.startClaudeCodeWatch(); // as main.ts: after the engine, before the window
    mainWindow = new FakeWindow();

    // Claude Code goes back to 2.1.200 under the running engine.
    writeClaude(local(), 'echo "2.1.200 (Claude Code)"');
    fake.installer = installerThatInstalls();
    await setup.recheckClaudeCodeNow("interval");

    expect(fake.installs).toBe(1);
    expect(FakeWindow.getAllWindows()).toEqual([mainWindow]); // no setup window: background
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(path.join(local(), "claude"));
    expect(refreshClaudeCatalog).toHaveBeenCalledTimes(1);
    expect(pageStatus()).toMatchObject({ version: "2.1.290", ok: true });
    expect(mainWindow.webContents.send).toHaveBeenLastCalledWith(
      setup.CLAUDE_CODE_STATUS_CHANNEL,
      expect.objectContaining({ version: "2.1.290", required: "2.1.284", ok: true }),
    );
  });

  it("an old package-manager copy first on PATH, a good native copy installed: the link moves to the native one", async () => {
    const brew = path.join(root, "homebrew", "bin");
    writeClaude(brew, 'echo "2.1.290 (Claude Code)"');
    const env = { ...baseEnv, PATH: `${brew}:/usr/bin:/bin` };
    vi.stubEnv("PATH", env.PATH);
    await setup.prepareEngineEnvironment(env);
    await setup.startClaudeCodeWatch();
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(path.join(brew, "claude"));

    writeClaude(brew, 'echo "2.1.283 (Claude Code)"');
    writeClaude(local(), 'echo "2.1.294 (Claude Code)"');
    await setup.recheckClaudeCodeNow("interval");

    expect(fake.installs).toBe(0);
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(path.join(local(), "claude"));
    expect(pageStatus()).toMatchObject({ version: "2.1.294", ok: true });
  });

  it("the setup at launch failed: the next check installs, links into the engine's folder, and the failure goes", async () => {
    setup.registerEngineSetup({ restartEngine: vi.fn() });
    const env = await setup.prepareEngineEnvironment(baseEnv); // offline: exit 1
    expect(env.PATH).toBe(`${binDir()}:${baseEnv.PATH}`);
    await setup.startClaudeCodeWatch();
    mainWindow = new FakeWindow();
    setup.finishEngineSetup();
    const win = openSetupWindow()!;
    await until(() => pageStatus() !== null); // measured once the setup is over
    expect(pageStatus()).toMatchObject({ version: null, ok: false });
    expect(fake.installs).toBe(1); // that measurement installed nothing

    fake.installer = installerThatInstalls();
    await setup.recheckClaudeCodeNow("interval");

    expect(fake.installs).toBe(2);
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(path.join(local(), "claude"));
    expect(setup.engineSetupStatus()).toBe("ready");
    expect(win.isDestroyed()).toBe(true);
    expect(pageStatus()).toMatchObject({ version: "2.1.290", ok: true });
  });

  it("an engine Orchestra did not launch: measured for the page, never installed over", async () => {
    writeClaude(local(), 'echo "2.1.200 (Claude Code)"');
    fake.installer = installerThatInstalls();
    await setup.startClaudeCodeWatch();
    expect(pageStatus()).toMatchObject({ version: "2.1.200", ok: false });
    expect(fake.installs).toBe(0);
    expect(existsSync(binDir())).toBe(false);
  });

  it("checks again on resume and unlock, at most every 5 minutes", async () => {
    writeClaude(local(), 'echo "2.1.290 (Claude Code)"');
    await setup.startClaudeCodeWatch(); // measures now: reused engine
    const first = pageStatus()?.checkedAt;
    electron.power.get("resume")?.();
    await sleep(50);
    expect(pageStatus()?.checkedAt).toBe(first); // throttled
  });

  it("the period can be shortened for a test run, and only to a positive integer", () => {
    expect(setup.claudeCodeCheckIntervalMs({})).toBe(30 * 60 * 1000);
    expect(
      setup.claudeCodeCheckIntervalMs({ [setup.CLAUDE_CODE_CHECK_INTERVAL_ENV]: "5000" }),
    ).toBe(5_000);
    expect(setup.claudeCodeCheckIntervalMs({ [setup.CLAUDE_CODE_CHECK_INTERVAL_ENV]: "x" })).toBe(
      30 * 60 * 1000,
    );
  });

  it("re-pointing the link never touches the file a running session executes", () => {
    const oldCopy = writeClaude(path.join(root, "versions", "a"), 'echo "2.1.283 (Claude Code)"');
    const newCopy = writeClaude(path.join(root, "versions", "b"), 'echo "2.1.294 (Claude Code)"');
    expect(setup.writeClaudeCodeShim(oldCopy, binDir(), "darwin")).toBe(binDir());
    expect(setup.writeClaudeCodeShim(newCopy, binDir(), "darwin")).toBe(binDir());
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(newCopy);
    expect(readFileSync(oldCopy, "utf8")).toContain("2.1.283");
  });
});

// ---------------------------------------------------------------------------
// 1.3.15: the newest version (V2), the failure for Settings (V1), terminal-bin (V3)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("1.3.15 on the desktop", () => {
  const binDir = () => path.join(electron.userData, "engine-bin");
  const terminalBin = () => path.join(electron.userData, "terminal-bin");
  const local = () => path.join(home, ".local", "bin");
  const brakeFile = () => path.join(electron.userData, setup.LATEST_ATTEMPT_FILE);
  const pageStatus = () => {
    const event: { sender: unknown; returnValue?: unknown } = { sender: null };
    electron.onHandlers.get(setup.CLAUDE_CODE_STATUS_GET_CHANNEL)?.(event);
    return event.returnValue as Record<string, unknown> | null;
  };
  const newest = (body: string) => {
    const reads = vi.fn(async () => body);
    setup.__setLatestClaudeCodeSource(reads);
    return reads;
  };
  /** The official installer for `version`, which notes whether the brake was on disk before it ran. */
  const installs = (version: string) => {
    const dir = local();
    return `test -f "${brakeFile()}" && touch "${root}/brake-was-written"; mkdir -p "${dir}" && printf '#!/bin/sh\\necho "${version} (Claude Code)"\\n' > "${dir}/claude" && chmod +x "${dir}/claude"`;
  };
  const OTHER_ENGINE =
    "[terminal] another engine is running: terminals use the person's own claude";
  const fakeCli = () => {
    const cli = getBundledCliShimPath();
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, '#!/bin/sh\necho "cli: $*"\n');
    chmodSync(cli, 0o755);
    return cli;
  };

  it("V2: a good copy below the newest goes to the newest at the first check; brake written before the installer", async () => {
    const reads = newest("2.1.295\n");
    writeClaude(local(), 'echo "2.1.289 (Claude Code)"');
    fake.installer = installs("2.1.295");
    await setup.prepareEngineEnvironment(baseEnv);
    expect(fake.installs).toBe(0); // the launch is not held up by it

    await setup.startClaudeCodeWatch(); // main.ts: the first check, in the background

    expect(fake.targets).toEqual(["2.1.295"]);
    expect(existsSync(path.join(root, "brake-was-written"))).toBe(true);
    expect(JSON.parse(readFileSync(brakeFile(), "utf8"))).toMatchObject({ target: "2.1.295" });
    expect(readlinkSync(path.join(binDir(), "claude"))).toBe(path.join(local(), "claude"));
    expect(pageStatus()).toMatchObject({ version: "2.1.295", ok: true, latest: "2.1.295" });

    await setup.recheckClaudeCodeNow("interval");
    expect(reads).toHaveBeenCalledTimes(1); // read at most once an hour
  });

  it("V2: a failed attempt above the minimum is the log's only; the brake holds across a restart; below the minimum it does not", async () => {
    newest("2.1.295");
    writeClaude(local(), 'echo "2.1.289 (Claude Code)"');
    fake.installer = 'echo "curl: (6) Could not resolve host" >&2; exit 6';
    await setup.prepareEngineEnvironment(baseEnv);
    await setup.startClaudeCodeWatch();
    expect(fake.installs).toBe(1);
    expect(pageStatus()).toMatchObject({ version: "2.1.289", ok: true, failure: null });

    await setup.recheckClaudeCodeNow("interval");
    expect(fake.installs).toBe(1); // braked

    // A new run of the app: the brake is on disk.
    setup.__resetEngineSetup();
    newest("2.1.295");
    await setup.prepareEngineEnvironment(baseEnv);
    await setup.startClaudeCodeWatch();
    expect(fake.installs).toBe(1);
    expect(pageStatus()).toMatchObject({ version: "2.1.289", ok: true, latest: "2.1.295" });

    // Below the minimum the brake does not hold, and the failure is Settings' business.
    writeClaude(local(), 'echo "2.1.200 (Claude Code)"');
    await setup.recheckClaudeCodeNow("interval");
    expect(fake.installs).toBe(2);
    expect(fake.targets).toEqual(["2.1.295", "2.1.295"]);
    const status = pageStatus();
    expect(status).toMatchObject({ version: "2.1.200", ok: false });
    const failure = status?.failure as { message: string; detail: string; at: string };
    expect(failure.message).toBe(
      "Claude Code 2.1.200 is older than 2.1.284 and could not be updated: the installer failed.",
    );
    expect(failure.detail).toContain("Could not resolve host");
  });

  it("V1: a failed launch is recorded with its reason, the bridge has every key, and an ok check clears it", async () => {
    setup.registerEngineSetup({ restartEngine: vi.fn() });
    fake.installer = 'echo "curl: (6) Could not resolve host: claude.ai" >&2; exit 6';
    await setup.prepareEngineEnvironment(baseEnv);
    await setup.startClaudeCodeWatch();
    await until(() => pageStatus() !== null);

    const status = pageStatus()!;
    expect(Object.keys(status).sort()).toEqual(
      [
        "version",
        "required",
        "ok",
        "checkedAt",
        "latest",
        "failure",
        "platform",
        "osVersion",
      ].sort(),
    );
    expect(status).toMatchObject({
      version: null,
      ok: false,
      latest: null, // the read failed
      platform: process.platform,
      osVersion: release().slice(0, 64),
    });
    const failure = status.failure as { message: string; detail: string; at: string };
    expect(failure.message).toBe(
      "Claude Code could not be installed. Check your internet connection and try again.",
    );
    expect(failure.detail).toBe("curl: (6) Could not resolve host: claude.ai");
    expect(new Date(failure.at).toISOString()).toBe(failure.at);

    fake.installer = installerThatInstalls();
    await setup.recheckClaudeCodeNow("interval");
    expect(pageStatus()).toMatchObject({ version: "2.1.290", ok: true, failure: null });
  });

  it("V3: the engine Orchestra launches gets terminal-bin and both variables; `claude` there runs the CLI", async () => {
    const cli = fakeCli();
    writeClaude(local());
    const env = await setup.prepareEngineEnvironment(baseEnv);

    expect(env.ORCHESTRA_TERMINAL_BIN).toBe(terminalBin());
    expect(env.ORCHESTRA_ENGINE_BIN).toBe(binDir());
    expect(env.PATH).toBe(`${binDir()}:/usr/bin:/bin`); // terminal-bin is the daemon's to place
    const shim = path.join(terminalBin(), "claude");
    expect(readdirSync(terminalBin())).toEqual(["claude"]);
    expect(readFileSync(shim, "utf8")).toBe(`#!/bin/sh\nexec "${cli}" maestro-claude -- "$@"\n`);
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    const run = await setup.runProcess(shim, ["-p", "say ok"], { env: baseEnv, timeoutMs: 5_000 });
    expect(run.output.trim()).toBe("cli: maestro-claude -- -p say ok");
    await setup.startClaudeCodeWatch();
    expect(log.info).not.toHaveBeenCalledWith(OTHER_ENGINE);

    // Written again at every launch.
    writeFileSync(shim, "stale");
    chmodSync(shim, 0o644);
    setup.__resetEngineSetup();
    await setup.prepareEngineEnvironment(baseEnv);
    expect(readFileSync(shim, "utf8")).toContain("maestro-claude");
    expect(statSync(shim).mode & 0o777).toBe(0o755);
  });

  it("V3: without Orchestra's CLI on disk (a development run) there is no terminal-bin", async () => {
    writeClaude(local());
    const env = await setup.prepareEngineEnvironment(baseEnv);
    expect(env.ORCHESTRA_TERMINAL_BIN).toBeUndefined();
    expect(env.ORCHESTRA_ENGINE_BIN).toBe(binDir());
    expect(existsSync(terminalBin())).toBe(false);
  });

  it("V3: an engine Orchestra did not launch gets nothing, and the log says so", async () => {
    fakeCli();
    writeClaude(local());
    await setup.startClaudeCodeWatch(); // no prepareEngineEnvironment: the daemon was reused
    expect(log.info).toHaveBeenCalledWith(OTHER_ENGINE);
    expect(existsSync(terminalBin())).toBe(false);
    expect(fake.installs).toBe(0);
  });
});

describe("terminalClaudeShims", () => {
  it("POSIX: one `claude` calling the CLI by absolute path, quoted", () => {
    expect(
      setup.terminalClaudeShims(
        "darwin",
        "/Applications/Orchestra.app/Contents/Resources/bin/paseo",
        "/t",
      ),
    ).toEqual([
      {
        file: "/t/claude",
        content:
          '#!/bin/sh\nexec "/Applications/Orchestra.app/Contents/Resources/bin/paseo" maestro-claude -- "$@"\n',
      },
    ]);
    expect(setup.terminalClaudeShims("linux", '/opt/a"b$c/paseo', "/t")[0]?.content).toBe(
      '#!/bin/sh\nexec "/opt/a\\"b\\$c/paseo" maestro-claude -- "$@"\n',
    );
  });

  it("Windows: `claude` for Git Bash and `claude.cmd` for cmd.exe and PowerShell, % escaped", () => {
    const cli =
      "C:\\Users\\100%real\\AppData\\Local\\Programs\\Orchestra\\resources\\bin\\paseo.cmd";
    const dir = "C:\\Users\\100%real\\AppData\\Local\\Orchestra\\terminal-bin";
    expect(setup.terminalClaudeShims("win32", cli, dir)).toEqual([
      {
        file: `${dir}\\claude`,
        content:
          '#!/bin/sh\nexec "C:/Users/100%real/AppData/Local/Programs/Orchestra/resources/bin/paseo.cmd" maestro-claude -- "$@"\n',
      },
      {
        file: `${dir}\\claude.cmd`,
        content:
          '@"C:\\Users\\100%%real\\AppData\\Local\\Programs\\Orchestra\\resources\\bin\\paseo.cmd" maestro-claude -- %*\r\n',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PortableGit: checked against the pinned SHA-256 before it is run
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("unpackPortableGit", () => {
  function fakeArchive(): {
    archive: string;
    sha256: string;
    layout: () => Parameters<typeof setup.unpackPortableGit>[0];
  } {
    // Stands in for the self-extractor: unpacks bin/bash.exe into the -o"<dir>" it is given.
    const archive = path.join(root, "resources", "git", "PortableGit-9.9.9-64-bit.7z.exe");
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(
      archive,
      '#!/bin/sh\nd="${1#-o}"; d="${d#\\"}"; d="${d%\\"}"; mkdir -p "$d/bin" && touch "$d/bin/bash.exe"\n',
    );
    chmodSync(archive, 0o755);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const dir = path.join(root, "local", "Orchestra", "git", "PortableGit-9.9.9-64-bit");
    return {
      archive,
      sha256,
      layout: () => ({
        archive,
        sha256,
        dir,
        bashPath: path.join(dir, "bin", "bash.exe"),
        cmdDir: path.join(dir, "cmd"),
        marker: path.join(dir, ".orchestra-ready"),
      }),
    };
  }

  it("a matching archive is unpacked, marked ready, and older copies go", async () => {
    const { layout } = fakeArchive();
    const older = path.join(root, "local", "Orchestra", "git", "PortableGit-2.55.0-64-bit");
    mkdirSync(older, { recursive: true });
    const run = await setup.unpackPortableGit(layout(), baseEnv, new AbortController().signal);
    expect(run.ok).toBe(true);
    expect(existsSync(layout().bashPath)).toBe(true);
    expect(existsSync(layout().marker)).toBe(true);
    expect(existsSync(older)).toBe(false);
  });

  it("an archive that does not match its pinned SHA-256 is never run", async () => {
    const { layout } = fakeArchive();
    const tampered = { ...layout(), sha256: "0".repeat(64) };
    const run = await setup.unpackPortableGit(tampered, baseEnv, new AbortController().signal);
    expect(run.ok).toBe(false);
    expect(run.output).toContain(`expected ${"0".repeat(64)}: not unpacked`);
    expect(run.message).toBe(
      "Orchestra's copy of Git Bash is damaged and was not used. Reinstall Orchestra.",
    );
    expect(existsSync(tampered.bashPath)).toBe(false);
    expect(existsSync(tampered.dir)).toBe(false);
  });
});
