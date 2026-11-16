import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineStatus1321 } from "./engine-status.js";
import type { EngineLock, EngineSupervisorOps, PortProbe } from "./engine-supervisor.js";

// Contract contratto-1321 §4.1 and §4.3: the engine supervisor against a fake world (port,
// pid lock, marker, executables, processes) on fake timers. The foreign stop runs the real
// daemon-manager stopForeignEngine with fake process edges, so the "still Paseo?" check
// before the fallback is exercised here too.

const mocks = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), getVersion: vi.fn(() => "1.3.21"), isPackaged: true },
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));
vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@getpaseo/server", () => ({
  resolvePaseoHome: vi.fn(() => "/tmp/orchestra-supervisor-home"),
  writeFileAtomic: vi.fn(),
}));
vi.mock("@getpaseo/server/daemon-control", () => ({
  resolvePaseoHome: vi.fn(() => "/tmp/orchestra-supervisor-home"),
  startDaemonInstance: vi.fn(),
  stopDaemonInstance: vi.fn(),
  readDaemonInstance: vi.fn(async () => null),
  isSameDaemonInstance: (a: { pid: number }, b: { pid: number }) => a.pid === b.pid,
  DaemonInstanceError: class extends Error {},
}));
vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({ get: async () => ({ daemon: { manageBuiltInDaemon: true } }) }),
}));
vi.mock("../daemon/runtime-paths.js", () => ({
  resolveBundledDaemonRuntime: vi.fn(),
  resolveBundledServerVersion: vi.fn(() => "0.10.2"),
}));
vi.mock("../daemon/cli/external.js", () => ({
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
}));
vi.mock("../integrations/cli-install/index.js", () => ({
  getBundledCliShimPath: vi.fn(() => "/bundled/bin/paseo"),
  getCliInstallStatus: vi.fn(),
  installCli: vi.fn(),
}));

const { createEngineSupervisorWith, RESTART_BACKOFF_MS } = await import("./engine-supervisor.js");
const { stopForeignEngine } = await import("../daemon/daemon-manager.js");

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__", "engine-status-1321.json"), "utf-8"),
) as { running: EngineStatus1321; error: EngineStatus1321 };

const PASEO_MAC =
  "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
const PASEO_WIN = "C:\\Users\\x\\AppData\\Local\\Programs\\Paseo\\Paseo.exe";
const ORCHESTRA_HELPER =
  "/Applications/Orchestra.app/Contents/Frameworks/Orchestra Helper.app/Contents/MacOS/Orchestra Helper";
const ORCHESTRA_FOLDER = "/Users/x/Library/Application Support/Orchestra/engine/bin/node";

const OWN_SERVER = "srv_own";

interface World {
  /** Who answers /api/status on the port; null = connection refused. */
  port: { serverId: string | null; version: string | null } | null;
  healthy: boolean;
  lock: EngineLock | null;
  owned: { pid: number; startedAt: string } | null;
  marker: { pid?: unknown; startedAt?: unknown } | null;
  executables: Map<number, string | null>;
  alive: Set<number>;
  launches: number;
  /** What the next launch does. */
  launchBehaviour: "ok" | "fail" | { hangMs: number };
  seedOk: boolean;
}

function freshWorld(): World {
  return {
    port: null,
    healthy: false,
    lock: null,
    owned: null,
    marker: null,
    executables: new Map(),
    alive: new Set(),
    launches: 0,
    launchBehaviour: "ok",
    seedOk: true,
  };
}

/** Our engine comes up: a new supervisor pid, its lock, the port answering. */
function ownEngineUp(world: World): void {
  world.launches += 1;
  const pid = 1000 + world.launches;
  const startedAt = `2026-11-16T15:00:0${world.launches % 10}.000Z`;
  world.lock = { pid, startedAt, serverId: OWN_SERVER };
  world.owned = { pid, startedAt };
  world.port = { serverId: OWN_SERVER, version: "0.10.2" };
  world.healthy = true;
  world.alive.add(pid);
  world.executables.set(pid, ORCHESTRA_HELPER);
}

function setForeign(world: World, executable: string | null, pid = 777): void {
  world.lock = { pid, startedAt: "2026-11-16T14:00:00.000Z", serverId: "srv_paseo" };
  world.port = { serverId: "srv_paseo", version: "0.16.0" };
  world.healthy = true;
  world.alive.add(pid);
  world.executables.set(pid, executable);
}

function releaseHolder(world: World, pid: number): void {
  world.alive.delete(pid);
  if (world.lock?.pid === pid) {
    world.lock = null;
    world.port = null;
    world.healthy = false;
  }
}

function setup(
  options: { platform?: NodeJS.Platform; cliStops?: boolean; signalsKill?: boolean } = {},
) {
  const signalsKill = options.signalsKill ?? true;
  const world = freshWorld();
  const log = vi.fn();
  const signals: Array<[number, string]> = [];
  const killTree = vi.fn(async (pid: number) => {
    if (signalsKill) releaseHolder(world, pid);
  });
  const cliStop = vi.fn(async () => {
    if (options.cliStops && world.lock) releaseHolder(world, world.lock.pid);
  });
  const forceStopOwn = vi.fn(async (instance: { pid: number }) => {
    releaseHolder(world, instance.pid);
    if (world.owned?.pid === instance.pid) world.owned = null;
    return true;
  });
  const startOwnEngine = vi.fn(async () => {
    const behaviour = world.launchBehaviour;
    if (behaviour === "fail") throw new Error("launch failed");
    if (behaviour !== "ok") {
      await new Promise((resolve) => setTimeout(resolve, behaviour.hangMs));
      throw new Error("launch timed out");
    }
    if (world.port) throw new Error("port still held");
    ownEngineUp(world);
  });
  const verifySeed = vi.fn(async () => world.seedOk);
  const readExecutable = vi.fn((pid: number) => world.executables.get(pid) ?? null);

  const ops: Partial<EngineSupervisorOps> = {
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    port: () => 6767,
    probeStatus: async (): Promise<PortProbe> =>
      world.port ? { kind: "busy", ...world.port } : { kind: "free" },
    probeHealth: async () => world.port !== null && world.healthy,
    readLock: async () => (world.lock && world.alive.has(world.lock.pid) ? world.lock : null),
    readMarker: () => world.marker,
    ownedLaunch: () => world.owned,
    readExecutable,
    forceStopOwn,
    stopForeign: (pid) =>
      stopForeignEngine(pid, {
        platform: options.platform ?? "darwin",
        cliStop,
        isAlive: (target) => world.alive.has(target),
        readExecutable,
        killTree,
        signal: (target, signal) => {
          signals.push([target, signal]);
          if (signalsKill) releaseHolder(world, target);
        },
        childPids: async () => [],
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log,
      }),
  };
  const supervisor = createEngineSupervisorWith({ startOwnEngine, verifySeed, log }, ops);
  return {
    world,
    supervisor,
    startOwnEngine,
    verifySeed,
    forceStopOwn,
    cliStop,
    killTree,
    signals,
    readExecutable,
    log,
  };
}

function expectNothingStopped(t: ReturnType<typeof setup>): void {
  expect(t.forceStopOwn).not.toHaveBeenCalled();
  expect(t.cliStop).not.toHaveBeenCalled();
  expect(t.killTree).not.toHaveBeenCalled();
  expect(t.signals).toEqual([]);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-16T15:00:00.000Z") });
  mocks.showMessageBox.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("engine supervisor: status shape", () => {
  it("status() has exactly the fields and types of the seam fixture", async () => {
    const t = setup();
    expect(Object.keys(t.supervisor.status()).sort()).toEqual(Object.keys(fixture.running).sort());
    await t.supervisor.start();
    const running = t.supervisor.status();
    expect(Object.keys(running).sort()).toEqual(Object.keys(fixture.running).sort());
    for (const key of Object.keys(fixture.running) as Array<keyof EngineStatus1321>) {
      expect(typeof running[key], key).toBe(typeof fixture.running[key]);
    }
    expect(running).toMatchObject({
      state: "running",
      version: "0.10.2",
      target: null,
      port: 6767,
      serverId: OWN_SERVER,
      managed: true,
      detail: null,
      notesDir: null,
      foreignStoppedAt: null,
    });
    expect(running.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("engine supervisor: §4.3 classification before the launch", () => {
  it("free port: our engine is launched, whatever the pid file says", async () => {
    const t = setup();
    t.world.lock = { pid: 55, startedAt: "x", serverId: "srv_stale" };
    await t.supervisor.start();
    expect(t.startOwnEngine).toHaveBeenCalledTimes(1);
    expect(t.supervisor.status().state).toBe("running");
    expectNothingStopped(t);
  });

  it("busy port and no pid file: error port_busy_other, nothing killed", async () => {
    const t = setup();
    t.world.port = { serverId: "srv_x", version: "1.0.0" };
    t.world.healthy = true;
    await t.supervisor.start();
    expect(t.supervisor.status()).toMatchObject({ state: "error", detail: "port_busy_other" });
    expect(t.startOwnEngine).not.toHaveBeenCalled();
    expectNothingStopped(t);
  });

  it("busy port, pid lock of a dead pid or of an earlier boot: port_busy_other", async () => {
    const t = setup();
    t.world.port = { serverId: "srv_paseo", version: "0.16.0" };
    t.world.healthy = true;
    // The lock names S, but S is not alive (or the lock predates this boot): readLock
    // (readDaemonInstance → isPidLockOwnerRunning) gives nothing.
    t.world.lock = { pid: 777, startedAt: "2026-11-15T08:00:00.000Z", serverId: "srv_paseo" };
    t.world.executables.set(777, PASEO_MAC);
    await t.supervisor.start();
    expect(t.supervisor.status()).toMatchObject({ state: "error", detail: "port_busy_other" });
    expectNothingStopped(t);
  });

  it("serverId of the port differs from the pid file's: port_busy_other", async () => {
    const t = setup();
    setForeign(t.world, PASEO_MAC);
    t.world.port = { serverId: "srv_someone_else", version: "0.16.0" };
    await t.supervisor.start();
    expect(t.supervisor.status()).toMatchObject({ state: "error", detail: "port_busy_other" });
    expectNothingStopped(t);
  });

  it("rule 0: our own launch is reused when healthy, force-stopped and relaunched when not", async () => {
    const t = setup();
    ownEngineUp(t.world);
    await t.supervisor.start();
    expect(t.startOwnEngine).not.toHaveBeenCalled();
    expect(t.supervisor.status().state).toBe("running");

    const u = setup();
    ownEngineUp(u.world);
    const first = u.world.lock!;
    u.world.healthy = false;
    await u.supervisor.start();
    expect(u.forceStopOwn).toHaveBeenCalledWith(first);
    expect(u.startOwnEngine).toHaveBeenCalledTimes(1);
    expect(u.supervisor.status().state).toBe("running");
    expect(u.cliStop).not.toHaveBeenCalled();
  });

  it("rule 2: the instance the marker names is ours: reused, or stopped when unhealthy", async () => {
    const t = setup();
    setForeign(t.world, PASEO_MAC, 4242);
    t.world.lock = { pid: 4242, startedAt: "2026-11-16T09:00:00.000Z", serverId: "srv_prev" };
    t.world.port = { serverId: "srv_prev", version: "0.10.1" };
    t.world.marker = { pid: 4242, startedAt: "2026-11-16T09:00:00.000Z" };
    await t.supervisor.start();
    expect(t.supervisor.status()).toMatchObject({ state: "running", serverId: "srv_prev" });
    expect(t.startOwnEngine).not.toHaveBeenCalled();
    expectNothingStopped(t);

    const u = setup();
    u.world.lock = { pid: 4242, startedAt: "2026-11-16T09:00:00.000Z", serverId: "srv_prev" };
    u.world.alive.add(4242);
    u.world.port = { serverId: "srv_prev", version: "0.10.1" };
    u.world.healthy = false;
    u.world.marker = { pid: 4242, startedAt: "2026-11-16T09:00:00.000Z" };
    await u.supervisor.start();
    expect(u.forceStopOwn).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }));
    expect(u.startOwnEngine).toHaveBeenCalledTimes(1);
    expect(u.cliStop).not.toHaveBeenCalled();
    expect(u.supervisor.status().state).toBe("running");
  });

  for (const [rule, executable] of [
    ["3 (Orchestra executable)", ORCHESTRA_HELPER],
    ["4 (under an Orchestra folder)", ORCHESTRA_FOLDER],
  ] as const) {
    it(`rule ${rule}: reused when healthy, never stopped when not`, async () => {
      const t = setup();
      setForeign(t.world, executable);
      await t.supervisor.start();
      expect(t.supervisor.status().state).toBe("running");
      expect(t.startOwnEngine).not.toHaveBeenCalled();

      const u = setup();
      setForeign(u.world, executable);
      u.world.healthy = false;
      await u.supervisor.start();
      expect(u.supervisor.status()).toMatchObject({ state: "error", detail: "health_failed" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(u.startOwnEngine).not.toHaveBeenCalled();
      expectNothingStopped(u);
    });
  }

  it("rule 5 (macOS): CLI stop, then the fallback; our engine replaces it, foreignStoppedAt set", async () => {
    const t = setup({ platform: "darwin", cliStops: false });
    setForeign(t.world, PASEO_MAC);
    const seen: EngineStatus1321[] = [];
    t.supervisor.onChange((status) => seen.push(status));
    await t.supervisor.start();
    expect(t.cliStop).toHaveBeenCalledTimes(1);
    expect(t.signals).toEqual([[777, "SIGTERM"]]);
    expect(t.cliStop.mock.invocationCallOrder[0]).toBeLessThan(
      t.readExecutable.mock.invocationCallOrder.at(-1)!,
    );
    expect(t.forceStopOwn).not.toHaveBeenCalled();
    expect(t.startOwnEngine).toHaveBeenCalledTimes(1);
    const status = t.supervisor.status();
    expect(status).toMatchObject({ state: "running", detail: null, serverId: OWN_SERVER });
    expect(status.foreignStoppedAt).toMatch(/Z$/);
    expect(seen.some((s) => s.detail === "foreign_replaced")).toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("rule 5 (Windows): CLI stop leaves it alive, taskkill of the tree", async () => {
    const t = setup({ platform: "win32", cliStops: false });
    setForeign(t.world, PASEO_WIN);
    await t.supervisor.start();
    expect(t.cliStop).toHaveBeenCalledTimes(1);
    expect(t.killTree).toHaveBeenCalledWith(777);
    expect(t.signals).toEqual([]);
    expect(t.supervisor.status().state).toBe("running");
    expect(t.supervisor.status().foreignStoppedAt).not.toBeNull();
  });

  it("rule 5: a CLI stop that works needs no fallback", async () => {
    const t = setup({ cliStops: true });
    setForeign(t.world, PASEO_MAC);
    await t.supervisor.start();
    expect(t.cliStop).toHaveBeenCalledTimes(1);
    expect(t.signals).toEqual([]);
    expect(t.killTree).not.toHaveBeenCalled();
    expect(t.supervisor.status().state).toBe("running");
  });

  for (const [label, executable] of [
    ["rule 6 (another program)", "/usr/local/bin/node"],
    ["an unreadable executable", null],
    ["a bare Paseo name without its install folder", "Paseo Helper"],
  ] as const) {
    it(`${label}: never stopped, error port_busy_other`, async () => {
      const t = setup();
      setForeign(t.world, executable);
      await t.supervisor.start();
      expect(t.supervisor.status()).toMatchObject({ state: "error", detail: "port_busy_other" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.startOwnEngine).not.toHaveBeenCalled();
      expectNothingStopped(t);
    });
  }

  for (const platform of ["darwin", "win32"] as const) {
    it(`${platform}: an executable that changes between classification and fallback is not killed`, async () => {
      const t = setup({ platform, cliStops: false });
      setForeign(t.world, platform === "win32" ? PASEO_WIN : PASEO_MAC);
      // Classified as Paseo; by the time the CLI stop is done, the pid is someone else's.
      t.cliStop.mockImplementation(async () => {
        t.world.executables.set(777, "/usr/sbin/sshd");
      });
      await t.supervisor.start();
      expect(t.cliStop).toHaveBeenCalledTimes(1);
      expect(t.killTree).not.toHaveBeenCalled();
      expect(t.signals).toEqual([]);
      expect(t.supervisor.status()).toMatchObject({
        state: "error",
        detail: "foreign_stop_failed",
        foreignStoppedAt: null,
      });
      expect(t.startOwnEngine).not.toHaveBeenCalled();
    });
  }

  it("a foreign engine that survives SIGTERM and SIGKILL: foreign_stop_failed", async () => {
    const t = setup({ cliStops: false, signalsKill: false });
    setForeign(t.world, PASEO_MAC);
    const started = t.supervisor.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await started;
    // Retried with the backoff, each retry going through the same steps.
    expect(t.signals.slice(0, 2)).toEqual([
      [777, "SIGTERM"],
      [777, "SIGKILL"],
    ]);
    expect(t.supervisor.status()).toMatchObject({
      state: "error",
      detail: "foreign_stop_failed",
      foreignStoppedAt: null,
    });
    expect(t.startOwnEngine).not.toHaveBeenCalled();
  });
});

describe("engine supervisor: §4.1 health, backoff, state", () => {
  async function runningThenDown(t: ReturnType<typeof setup>): Promise<number> {
    await t.supervisor.start();
    expect(t.supervisor.status().state).toBe("running");
    t.world.healthy = false;
    t.world.launchBehaviour = "fail";
    const before = Date.now();
    await vi.advanceTimersByTimeAsync(30_000);
    return before;
  }

  it("3 failed health checks: our engine is force-stopped and restarted with 2/5/15/30/60 s backoff", async () => {
    const t = setup();
    await t.supervisor.start();
    const launchTimes: number[] = [];
    t.startOwnEngine.mockImplementation(async () => {
      launchTimes.push(Date.now());
      throw new Error("launch failed");
    });
    const own = t.world.lock!;
    t.world.healthy = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.forceStopOwn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.forceStopOwn).toHaveBeenCalledWith(own);
    expect(launchTimes).toHaveLength(1);
    const fault = launchTimes[0];
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000 + 30_000 + 60_000 + 60_000);
    const gaps = launchTimes.slice(1).map((time, i) => time - launchTimes[i]);
    expect(gaps).toEqual([...RESTART_BACKOFF_MS, 60_000]);
    expect(launchTimes[0]).toBe(fault);
    expect(t.cliStop).not.toHaveBeenCalled();
  });

  it("starting during the first attempts, error after the third failed one", async () => {
    const t = setup();
    await runningThenDown(t);
    expect(t.supervisor.status()).toMatchObject({ state: "starting", detail: "restart_failed" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.supervisor.status().state).toBe("starting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.supervisor.status()).toMatchObject({
      state: "error",
      detail: "restart_failed",
      version: null,
      serverId: null,
    });
  });

  it("error after 120 s without running, even before the third attempt", async () => {
    const t = setup();
    await t.supervisor.start();
    t.world.healthy = false;
    t.world.launchBehaviour = { hangMs: 50_000 };
    await vi.advanceTimersByTimeAsync(30_000);
    const faultAt = Date.now();
    expect(t.supervisor.status().state).toBe("starting");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(t.supervisor.status().state).toBe("starting");
    // The first launch, then three after the fault: only two of them have failed so far.
    expect(t.startOwnEngine.mock.calls.length).toBe(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.supervisor.status().state).toBe("error");
    expect(Date.now() - faultAt).toBe(120_000);
  });

  it("in error, since does not move until running; detail may", async () => {
    const t = setup();
    await runningThenDown(t);
    await vi.advanceTimersByTimeAsync(7_000);
    const errorSince = t.supervisor.status().since;
    expect(t.supervisor.status().state).toBe("error");
    t.startOwnEngine.mockImplementationOnce(async () => {
      throw new Error("x");
    });
    await vi.advanceTimersByTimeAsync(15_000 + 30_000 + 60_000);
    expect(t.supervisor.status()).toMatchObject({ state: "error", since: errorSince });
    t.world.launchBehaviour = "ok";
    await vi.advanceTimersByTimeAsync(60_000);
    const status = t.supervisor.status();
    expect(status.state).toBe("running");
    expect(status.since).not.toBe(errorSince);
    expect(status.detail).toBeNull();
  });

  it("a supervisor alive without the port: stuck_supervisor, force-stopped", async () => {
    const t = setup();
    await t.supervisor.start();
    const own = t.world.lock!;
    // The worker died: the port refuses, the supervisor still holds the lock.
    t.world.port = null;
    t.world.launchBehaviour = "fail";
    const seen: EngineStatus1321[] = [];
    t.supervisor.onChange((status) => seen.push(status));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen.some((s) => s.detail === "stuck_supervisor")).toBe(true);
    expect(t.forceStopOwn).toHaveBeenCalledWith(own);
  });

  it("restartNow: false in running and nothing stopped; in error it resets the backoff and tries now", async () => {
    const t = setup();
    await t.supervisor.start();
    expect(await t.supervisor.restartNow()).toBe(false);
    expect(t.forceStopOwn).not.toHaveBeenCalled();
    expect(t.startOwnEngine).toHaveBeenCalledTimes(1);

    await runningThenDownFrom(t);
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000);
    expect(t.supervisor.status().state).toBe("error");
    const calls = t.startOwnEngine.mock.calls.length;
    t.world.launchBehaviour = "ok";
    expect(await t.supervisor.restartNow()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.startOwnEngine.mock.calls.length).toBe(calls + 1);
    expect(t.supervisor.status().state).toBe("running");
  });

  async function runningThenDownFrom(t: ReturnType<typeof setup>): Promise<void> {
    t.world.healthy = false;
    t.world.launchBehaviour = "fail";
    await vi.advanceTimersByTimeAsync(30_000);
  }

  it("after stop(): restartNow is false and no attempt ever starts", async () => {
    const t = setup();
    await runningThenDown(t);
    const calls = t.startOwnEngine.mock.calls.length;
    t.supervisor.stop();
    expect(await t.supervisor.restartNow()).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(t.startOwnEngine.mock.calls.length).toBe(calls);
  });

  it("stop() during a launch: the launch is abandoned, nothing follows", async () => {
    const t = setup();
    t.world.launchBehaviour = { hangMs: 20_000 };
    const started = t.supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    t.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await started;
    expect(t.startOwnEngine).toHaveBeenCalledTimes(1);
    expect(t.supervisor.status().state).toBe("starting");
  });

  it("a failed seed on our engine: error seed_failed, no dialog", async () => {
    const t = setup();
    t.world.seedOk = false;
    await t.supervisor.start();
    expect(t.verifySeed).toHaveBeenCalledTimes(1);
    expect(t.supervisor.status()).toMatchObject({ state: "error", detail: "seed_failed" });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    // The engine is up: the retry re-checks the seed without relaunching.
    t.world.seedOk = true;
    await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS[0]);
    expect(t.supervisor.status()).toMatchObject({ state: "running", detail: null });
    expect(t.startOwnEngine).toHaveBeenCalledTimes(1);
  });

  it("a restart made by the seed check counts as one of the supervisor's attempts", async () => {
    const t = setup();
    t.verifySeed.mockImplementationOnce(async () => {
      // The seed check stops our engine and launches a new one (outdated plugin).
      releaseHolder(t.world, t.world.lock!.pid);
      ownEngineUp(t.world);
      return true;
    });
    await t.supervisor.start();
    expect(t.log).toHaveBeenCalledWith("engine supervisor: the seed check restarted the engine", {
      failedAttempts: 1,
    });
    expect(t.supervisor.status()).toMatchObject({ state: "running", serverId: OWN_SERVER });
  });
});
