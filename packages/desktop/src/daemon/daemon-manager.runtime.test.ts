import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonLaunchRuntime } from "./runtime-paths.js";

// Figmenta fork: behaviour of the daemon-runtime choice and of the bundled fallback,
// through the real daemon-manager with the process-level edges mocked.

const mocks = vi.hoisted(() => {
  class DaemonInstanceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    DaemonInstanceError,
    startDaemonInstance: vi.fn(),
    readDaemonInstance: vi.fn(async (): Promise<unknown> => null),
    stopDaemonInstance: vi.fn(),
    runExternalCliJsonCommand: vi.fn(),
    resolveBundledDaemonRuntime: vi.fn(),
    resolvePaseoAppDaemonRuntime: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), getVersion: vi.fn(() => "1.0.0"), isPackaged: true },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: { info: mocks.logInfo, error: vi.fn(), warn: mocks.logWarn },
}));

vi.mock("@getpaseo/server/daemon-control", () => ({
  resolvePaseoHome: vi.fn(() => "/tmp/orchestra-test-home"),
  startDaemonInstance: mocks.startDaemonInstance,
  stopDaemonInstance: mocks.stopDaemonInstance,
  readDaemonInstance: mocks.readDaemonInstance,
  isSameDaemonInstance: (a: { pid: number }, b: { pid: number }) => a.pid === b.pid,
  DaemonInstanceError: mocks.DaemonInstanceError,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => ({ daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true } }),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  resolveBundledDaemonRuntime: mocks.resolveBundledDaemonRuntime,
  resolveBundledServerVersion: vi.fn(() => "0.9.2"),
  resolvePaseoAppDaemonRuntime: mocks.resolvePaseoAppDaemonRuntime,
}));

vi.mock("./cli/external.js", () => ({
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: vi.fn(),
}));

vi.mock("../integrations/cli-install/index.js", () => ({
  getBundledCliShimPath: vi.fn(() => "/bundled/bin/paseo"),
  getCliInstallStatus: vi.fn(),
  installCli: vi.fn(),
}));

const {
  createDaemonCommandHandlers,
  launchWithBundledFallback,
  pickOrchestraDaemonRuntime,
  setEngineEnvironmentPreparer,
  stopForeignEngine,
  EngineHolderError,
  engineProcessProbe,
  forceStopOwnEngine,
  lastForeignEngineStopAt,
  startDaemon,
  ownedLaunchInstance,
} = await import("./daemon-manager.js");

const TEST_HOME = "/tmp/orchestra-test-home";
const ORCHESTRA_OTHER =
  "/Users/x/Downloads/Orchestra 2.app/Contents/Frameworks/Orchestra Helper.app/Contents/MacOS/Orchestra Helper";
const PASEO_HELPER =
  "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
const NOT_AN_ENGINE = "/usr/bin/foo";
// A pid no process has: the foreign stop sees it gone after the graceful stop.
const DEAD_PID = 999_999;

function writeMarker(instance: { pid: number; startedAt: string } | null): void {
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (!instance) return;
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(path.join(TEST_HOME, "orchestra-daemon.json"), JSON.stringify(instance));
}

function liveStatus(pid: number, startedAt: string) {
  return {
    localDaemon: "running",
    serverId: "srv",
    listen: "127.0.0.1:6767",
    pid,
    startedAt,
    daemonVersion: "0.9.2",
    desktopManaged: true,
  };
}

function stopCalls(): unknown[][] {
  return mocks.runExternalCliJsonCommand.mock.calls.filter((call) =>
    (call[0] as string[]).includes("stop"),
  );
}

function runtime(source: "bundled" | "paseo-app", version: string): DaemonLaunchRuntime {
  return {
    source,
    version,
    location: `/${source}`,
    cliPath: `/${source}/bin/paseo`,
    createInvocation: () => ({ command: `/${source}/node`, args: [], env: {} }),
  };
}

function launchedCommands(): string[] {
  return mocks.startDaemonInstance.mock.calls.map(
    (call) => (call[0] as { command: string }).command,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  writeMarker(null);
});

beforeEach(() => {
  mocks.stopDaemonInstance.mockReset();
  mocks.startDaemonInstance.mockReset();
  mocks.readDaemonInstance.mockReset();
  mocks.readDaemonInstance.mockResolvedValue(null);
  mocks.runExternalCliJsonCommand.mockReset();
  mocks.resolveBundledDaemonRuntime.mockReset();
  mocks.resolvePaseoAppDaemonRuntime.mockReset();
});

// contratto-1321 §4.1: from 1.3.21 our engine always runs on the bundled runtime.
describe("pickOrchestraDaemonRuntime", () => {
  it("always the bundled runtime, never an installed Paseo.app's, even when newer", () => {
    const bundled = runtime("bundled", "0.8.0");
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(runtime("paseo-app", "0.9.2"));
    expect(pickOrchestraDaemonRuntime(bundled)).toBe(bundled);
    expect(mocks.resolvePaseoAppDaemonRuntime).not.toHaveBeenCalled();
  });
});

describe("launchWithBundledFallback", () => {
  const bundled = runtime("bundled", "0.8.0");
  const paseoApp = runtime("paseo-app", "0.9.2");

  it("stops at the newer runtime when it comes up", async () => {
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    await launchWithBundledFallback("/home", bundled, paseoApp);
    expect(launchedCommands()).toEqual(["/paseo-app/node"]);
  });

  it("falls back to the bundled server when the newer runtime fails to start", async () => {
    mocks.startDaemonInstance
      .mockRejectedValueOnce(new mocks.DaemonInstanceError("DAEMON_START_FAILED", "exit 1"))
      .mockResolvedValueOnce({ spawned: true });
    await launchWithBundledFallback("/home", bundled, paseoApp);
    expect(launchedCommands()).toEqual(["/paseo-app/node", "/bundled/node"]);
  });

  it("stops a newer runtime that never becomes ready, then starts the bundled one", async () => {
    let signal: AbortSignal | undefined;
    mocks.startDaemonInstance
      .mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
        signal = input.signal;
        throw new mocks.DaemonInstanceError("DAEMON_NOT_READY", "no lock in 30s");
      })
      .mockResolvedValueOnce({ spawned: true });
    await launchWithBundledFallback("/home", bundled, paseoApp);
    expect(signal?.aborted).toBe(true);
    expect(launchedCommands()).toEqual(["/paseo-app/node", "/bundled/node"]);
  });

  it("does not retry the bundled server with itself", async () => {
    mocks.startDaemonInstance.mockRejectedValue(new Error("boom"));
    await expect(launchWithBundledFallback("/home", bundled, bundled)).rejects.toThrow("boom");
    expect(launchedCommands()).toEqual(["/bundled/node"]);
  });
});

describe("start_desktop_daemon", () => {
  it("with nothing listening, launches the bundled server even when Paseo.app's is newer", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({ localDaemon: "stopped", serverId: "" });
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.8.0"));
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(runtime("paseo-app", "0.9.2"));
    mocks.startDaemonInstance.mockResolvedValueOnce({ spawned: true });

    await createDaemonCommandHandlers().start_desktop_daemon();

    expect(launchedCommands()).toEqual(["/bundled/node"]);
    expect(mocks.startDaemonInstance.mock.calls[0][0]).toMatchObject({
      env: { PASEO_CLI: "/bundled/bin/paseo" },
      desktopManaged: true,
    });
  });

  it("a launch marker that cannot be written is logged and does not stop the launch", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({ localDaemon: "stopped", serverId: "" });
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.9.2"));
    // The test home does not exist: writing orchestra-daemon.json fails.
    mocks.startDaemonInstance.mockImplementationOnce(
      async (input: { onAcquired: (instance: unknown) => void }) => {
        input.onAcquired({ pid: 31, startedAt: "2026-11-16T15:00:00.000Z" });
        return { spawned: true };
      },
    );

    await expect(createDaemonCommandHandlers().start_desktop_daemon()).resolves.toBeDefined();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "[desktop daemon]",
      "could not record the Orchestra launch marker",
      expect.objectContaining({ pid: 31 }),
    );
  });

  it("a live lock of another Orchestra: port_busy_other, no launch, no stop", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue(liveStatus(42, "2026-11-16T08:00:00.000Z"));
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(ORCHESTRA_OTHER);
    const release = vi.spyOn(engineProcessProbe, "releaseStaleLock");
    const error = await startDaemon().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineHolderError);
    expect((error as InstanceType<typeof EngineHolderError>).reason).toBe("port_busy_other");
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(stopCalls()).toEqual([]);
  });

  it("a live lock whose pid is not an engine (reused pid): released, nothing signalled, launched", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue(liveStatus(42, "2026-11-16T08:00:00.000Z"));
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.9.2"));
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(NOT_AN_ENGINE);
    const release = vi.spyOn(engineProcessProbe, "releaseStaleLock").mockResolvedValue(undefined);
    const kill = vi.spyOn(process, "kill");
    await startDaemon();
    expect(release).toHaveBeenCalledWith(TEST_HOME, {
      pid: 42,
      startedAt: "2026-11-16T08:00:00.000Z",
    });
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    expect(stopCalls()).toEqual([]);
    expect(launchedCommands()).toEqual(["/bundled/node"]);
  });

  it("the marker's own instance on a reused pid: released and relaunched, never reused", async () => {
    const lock = { pid: 42, startedAt: "2026-11-16T08:00:00.000Z" };
    writeMarker(lock);
    mocks.runExternalCliJsonCommand.mockResolvedValue(liveStatus(lock.pid, lock.startedAt));
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.9.2"));
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(NOT_AN_ENGINE);
    const release = vi.spyOn(engineProcessProbe, "releaseStaleLock").mockResolvedValue(undefined);
    await startDaemon();
    expect(release).toHaveBeenCalledWith(TEST_HOME, lock);
    expect(launchedCommands()).toEqual(["/bundled/node"]);
  });

  it("a live lock of a Paseo engine: stopped in process (no force), then ours launched", async () => {
    const lock = { pid: DEAD_PID, startedAt: "2026-11-16T08:00:00.000Z" };
    mocks.runExternalCliJsonCommand.mockResolvedValue(liveStatus(lock.pid, lock.startedAt));
    mocks.readDaemonInstance.mockResolvedValue({ ...lock, listen: "127.0.0.1:6767" });
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.9.2"));
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(PASEO_HELPER);
    await startDaemon();
    expect(mocks.stopDaemonInstance).toHaveBeenCalledTimes(1);
    expect(mocks.stopDaemonInstance.mock.calls[0][0]).toBe(TEST_HOME);
    expect(mocks.stopDaemonInstance.mock.calls[0][1]).toMatchObject({
      instance: expect.objectContaining(lock),
      force: false,
      timeoutMs: 15_000,
    });
    expect(lastForeignEngineStopAt()).not.toBeNull();
    expect(launchedCommands()).toEqual(["/bundled/node"]);
  });

  it("concurrent starts share one launch", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({ localDaemon: "stopped", serverId: "" });
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.9.2"));
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    const first = startDaemon();
    const second = startDaemon();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.startDaemonInstance).toHaveBeenCalledTimes(1);
  });

  it("an aborted start abandons the launch: no lock recorded as ours after the abort", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({ localDaemon: "stopped", serverId: "" });
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.9.2"));
    let seen: AbortSignal | undefined;
    mocks.startDaemonInstance.mockImplementationOnce(
      async (input: { signal?: AbortSignal; onAcquired: (instance: unknown) => void }) => {
        seen = input.signal;
        await new Promise((resolve) => input.signal?.addEventListener("abort", resolve));
        input.onAcquired({ pid: 77, startedAt: "2026-11-16T15:00:00.000Z" });
        throw new Error("aborted");
      },
    );
    const controller = new AbortController();
    const started = startDaemon(controller.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await expect(started).rejects.toThrow("aborted");
    expect(seen?.aborted).toBe(true);
    expect(ownedLaunchInstance()?.pid).not.toBe(77);
  });
});

// contratto-1321 §4.1 and review #1: the forced stop of OUR engine, in process.
describe("forceStopOwnEngine", () => {
  const lock = { pid: 42, startedAt: "2026-11-16T08:00:00.000Z" };

  it("live lock, marker matching, executable /usr/bin/foo: lock released, no CLI, no stop, no signal", async () => {
    writeMarker(lock);
    mocks.readDaemonInstance.mockResolvedValue({ ...lock, listen: "127.0.0.1:6767" });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(NOT_AN_ENGINE);
    const release = vi.spyOn(engineProcessProbe, "releaseStaleLock").mockResolvedValue(undefined);
    const kill = vi.spyOn(process, "kill");
    expect(await forceStopOwnEngine(lock)).toBe(true);
    expect(release).toHaveBeenCalledWith(TEST_HOME, expect.objectContaining(lock));
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("live lock, marker matching, executable unreadable: nothing released, nothing stopped", async () => {
    writeMarker(lock);
    mocks.readDaemonInstance.mockResolvedValue({ ...lock, listen: "127.0.0.1:6767" });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(null);
    const release = vi.spyOn(engineProcessProbe, "releaseStaleLock").mockResolvedValue(undefined);
    const kill = vi.spyOn(process, "kill");
    expect(await forceStopOwnEngine(lock)).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("our engine: stopDaemonInstance on that instance with force, shutdown asked over --host", async () => {
    writeMarker(lock);
    mocks.readDaemonInstance.mockResolvedValue({ ...lock, listen: "127.0.0.1:6767" });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(ORCHESTRA_OTHER);
    expect(await forceStopOwnEngine(lock)).toBe(true);
    const [home, options] = mocks.stopDaemonInstance.mock.calls[0] as [
      string,
      {
        instance: unknown;
        force: boolean;
        timeoutMs: number;
        requestShutdown: (ready: { listen: string }) => Promise<void>;
      },
    ];
    expect(home).toBe(TEST_HOME);
    expect(options).toMatchObject({
      instance: expect.objectContaining(lock),
      force: true,
      timeoutMs: 15_000,
    });
    mocks.runExternalCliJsonCommand.mockResolvedValue({});
    await options.requestShutdown({ listen: "127.0.0.1:6767" });
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6767",
      "--json",
    ]);
  });

  it("a lock replaced during the stop (DAEMON_REPLACED): reported as not stopped", async () => {
    writeMarker(lock);
    mocks.readDaemonInstance.mockResolvedValue({ ...lock, listen: "127.0.0.1:6767" });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(ORCHESTRA_OTHER);
    mocks.stopDaemonInstance.mockRejectedValue(
      new mocks.DaemonInstanceError("DAEMON_REPLACED", "changed"),
    );
    expect(await forceStopOwnEngine(lock)).toBe(false);
  });

  it("a lock that is not ours is never stopped", async () => {
    writeMarker(null);
    mocks.readDaemonInstance.mockResolvedValue({ ...lock, listen: "127.0.0.1:6767" });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(PASEO_HELPER);
    expect(await forceStopOwnEngine(lock)).toBe(false);
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });
});

// Figmenta fork: the environment of an engine this app launches (Claude Code on PATH, Git Bash).
describe("engine environment", () => {
  const STOPPED = { localDaemon: "stopped", serverId: "" };

  function envRuntime(source: "bundled" | "paseo-app", version: string): DaemonLaunchRuntime {
    return {
      ...runtime(source, version),
      createInvocation: (input) => ({
        command: `/${source}/node`,
        args: [],
        env: { ...input.baseEnv },
      }),
    };
  }

  function launchedEnvs(): NodeJS.ProcessEnv[] {
    return mocks.startDaemonInstance.mock.calls.map(
      (call) => (call[0] as { env: NodeJS.ProcessEnv }).env,
    );
  }

  afterEach(() => setEngineEnvironmentPreparer(null));

  it("an engine this app launches runs with the prepared environment", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue(STOPPED);
    mocks.resolveBundledDaemonRuntime.mockReturnValue(envRuntime("bundled", "0.8.0"));
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(envRuntime("paseo-app", "0.9.2"));
    mocks.startDaemonInstance.mockResolvedValueOnce({ spawned: true });
    const preparer = vi.fn(async (base: NodeJS.ProcessEnv) => ({
      ...base,
      PATH: "/Users/me/.local/bin:/usr/bin",
      ORCHESTRA_TEST_PREPARED: "1",
    }));
    setEngineEnvironmentPreparer(preparer);

    await createDaemonCommandHandlers().start_desktop_daemon();

    expect(preparer).toHaveBeenCalledTimes(1);
    expect(preparer).toHaveBeenCalledWith(process.env);
    const envs = launchedEnvs();
    expect(envs).toHaveLength(1);
    for (const env of envs) {
      expect(env).toMatchObject({
        PATH: "/Users/me/.local/bin:/usr/bin",
        ORCHESTRA_TEST_PREPARED: "1",
      });
    }
  });

  it("a daemon already listening is not launched over: nothing is prepared or installed", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      ...liveStatus(42, "2026-11-16T08:00:00.000Z"),
      desktopManaged: false,
    });
    vi.spyOn(engineProcessProbe, "executable").mockReturnValue(ORCHESTRA_OTHER);
    const preparer = vi.fn(async (base: NodeJS.ProcessEnv) => base);
    setEngineEnvironmentPreparer(preparer);

    await expect(createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();

    expect(preparer).not.toHaveBeenCalled();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
  });

  it("a setup that failed or was closed hands back the app's env: the engine is launched anyway", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue(STOPPED);
    mocks.resolveBundledDaemonRuntime.mockReturnValue(envRuntime("bundled", "0.9.2"));
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(null);
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    setEngineEnvironmentPreparer(async (base) => base);

    await createDaemonCommandHandlers().start_desktop_daemon();

    expect(launchedEnvs()).toHaveLength(1);
    expect(launchedEnvs()[0]).toMatchObject({ PATH: process.env.PATH });
  });

  it("a preparer that throws does not keep the engine down: it starts with the app's env", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue(STOPPED);
    mocks.resolveBundledDaemonRuntime.mockReturnValue(envRuntime("bundled", "0.9.2"));
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(null);
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });
    setEngineEnvironmentPreparer(async () => {
      throw new Error("statSync exploded");
    });

    await createDaemonCommandHandlers().start_desktop_daemon();

    expect(launchedEnvs()).toHaveLength(1);
    expect(launchedEnvs()[0]).toMatchObject({ PATH: process.env.PATH });
  });

  it("without a preparer (upstream behaviour) the engine gets the app's environment", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue(STOPPED);
    mocks.resolveBundledDaemonRuntime.mockReturnValue(envRuntime("bundled", "0.9.2"));
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(null);
    mocks.startDaemonInstance.mockResolvedValue({ spawned: true });

    await createDaemonCommandHandlers().start_desktop_daemon();

    expect(launchedEnvs()[0]).toMatchObject({ PATH: process.env.PATH });
  });
});

// contratto-1321 §4.3: stopping a FOREIGN (Paseo) engine — the CLI first, then the
// fallback, and the fallback only on an executable that still reads as Paseo.
describe("stopForeignEngine", () => {
  const PASEO =
    "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
  const PASEO_WIN = "C:\\Users\\x\\AppData\\Local\\Programs\\Paseo\\Paseo.exe";

  function fakeOps(input: {
    platform: NodeJS.Platform;
    executables: Map<number, string | null>;
    cliKills?: boolean;
    signalKills?: "SIGTERM" | "SIGKILL" | "never";
    children?: number[];
  }) {
    const alive = new Set<number>([7, ...(input.children ?? [])]);
    const calls: string[] = [];
    const ops = {
      platform: input.platform,
      cliStop: vi.fn(async () => {
        calls.push("cli");
        if (input.cliKills) alive.delete(7);
      }),
      isAlive: (pid: number) => alive.has(pid),
      readExecutable: vi.fn((pid: number) => input.executables.get(pid) ?? null),
      killTree: vi.fn(async (pid: number) => {
        calls.push(`taskkill ${pid}`);
        alive.delete(pid);
      }),
      signal: vi.fn((pid: number, signal: "SIGTERM" | "SIGKILL") => {
        calls.push(`${signal} ${pid}`);
        if (
          input.signalKills === signal ||
          (input.signalKills === "SIGTERM" && signal === "SIGKILL")
        ) {
          alive.delete(pid);
        }
      }),
      childPids: vi.fn(async () => input.children ?? []),
      sleep: async () => {},
      log: vi.fn(),
    };
    return { ops, calls, alive };
  }

  it("a CLI stop that works is the whole stop", async () => {
    const { ops, calls } = fakeOps({
      platform: "darwin",
      executables: new Map([[7, PASEO]]),
      cliKills: true,
    });
    expect(await stopForeignEngine(7, ops)).toBe("stopped");
    expect(calls).toEqual(["cli"]);
  });

  it("Windows: CLI, then taskkill /T /F of the tree — never anything else", async () => {
    const { ops, calls } = fakeOps({ platform: "win32", executables: new Map([[7, PASEO_WIN]]) });
    expect(await stopForeignEngine(7, ops)).toBe("stopped");
    expect(calls).toEqual(["cli", "taskkill 7"]);
    expect(ops.signal).not.toHaveBeenCalled();
  });

  it("posix: CLI, SIGTERM, 12 s, then SIGKILL of S and of its children still on Paseo", async () => {
    const { ops, calls } = fakeOps({
      platform: "darwin",
      executables: new Map([
        [7, PASEO],
        [8, PASEO],
        [9, "/usr/bin/ssh"],
      ]),
      signalKills: "SIGKILL",
      children: [8, 9],
    });
    expect(await stopForeignEngine(7, ops)).toBe("stopped");
    expect(calls).toEqual(["cli", "SIGTERM 7", "SIGKILL 7", "SIGKILL 8"]);
  });

  it("posix: S that leaves on SIGTERM gets no SIGKILL", async () => {
    const { ops, calls } = fakeOps({
      platform: "linux",
      executables: new Map([[7, "/opt/Paseo/paseo"]]),
      signalKills: "SIGTERM",
    });
    expect(await stopForeignEngine(7, ops)).toBe("stopped");
    expect(calls).toEqual(["cli", "SIGTERM 7"]);
  });

  for (const platform of ["darwin", "win32"] as const) {
    it(`${platform}: an executable that is no longer Paseo after the CLI is never signalled`, async () => {
      const { ops, calls } = fakeOps({
        platform,
        executables: new Map([[7, "/usr/sbin/sshd"]]),
        signalKills: "SIGTERM",
      });
      expect(await stopForeignEngine(7, ops)).toBe("not_paseo");
      expect(calls).toEqual(["cli"]);
      expect(ops.killTree).not.toHaveBeenCalled();
      expect(ops.signal).not.toHaveBeenCalled();
    });
  }

  it("a lock replaced under the graceful stop (DAEMON_REPLACED): nothing stopped, no signal", async () => {
    const { ops, calls } = fakeOps({ platform: "darwin", executables: new Map([[7, PASEO]]) });
    ops.cliStop.mockImplementation(async () => {
      calls.push("cli");
      return "replaced" as const;
    });
    expect(await stopForeignEngine(7, ops)).toBe("replaced");
    expect(calls).toEqual(["cli"]);
    expect(ops.signal).not.toHaveBeenCalled();
    expect(ops.killTree).not.toHaveBeenCalled();
  });

  it("an executable that cannot be read is never signalled", async () => {
    const { ops, calls } = fakeOps({ platform: "darwin", executables: new Map([[7, null]]) });
    expect(await stopForeignEngine(7, ops)).toBe("not_paseo");
    expect(calls).toEqual(["cli"]);
  });
});
