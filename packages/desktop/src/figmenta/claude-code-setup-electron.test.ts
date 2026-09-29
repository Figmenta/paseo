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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    onHandlers: new Map<string, (event: { sender: unknown }) => void>(),
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
}));

vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real resolution, confined to this test's folders (a real claude on this machine is not
// the test's business), and a fake official installer.
const fake = vi.hoisted(() => ({ root: "", installer: "exit 1", installs: 0 }));
vi.mock("./claude-code-setup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./claude-code-setup.js")>();
  return {
    ...real,
    resolveClaudeCode: (input: Parameters<typeof real.resolveClaudeCode>[0]) =>
      real.resolveClaudeCode({
        ...input,
        exists: (file) => file.startsWith(fake.root) && input.exists(file),
      }),
    claudeCodeInstallerCommand: (_platform: NodeJS.Platform, env: Record<string, string>) => {
      fake.installs += 1;
      return { command: "/bin/sh", args: ["-c", fake.installer], env };
    },
  };
});

const setup = await import("./claude-code-setup-electron.js");

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

  it("the first `claude` on PATH is good: PATH untouched, no private folder", async () => {
    const local = path.join(home, ".local", "bin");
    writeClaude(local);
    const env = await setup.prepareEngineEnvironment({ ...baseEnv, PATH: `${local}:/usr/bin` });
    expect(env.PATH).toBe(`${local}:/usr/bin`);
    expect(existsSync(binDir())).toBe(false);
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

    expect(env).toEqual(baseEnv);
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
    expect(env).toEqual(baseEnv);
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
    expect(env).toEqual(baseEnv);
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
