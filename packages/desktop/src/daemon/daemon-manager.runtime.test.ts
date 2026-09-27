import { beforeEach, describe, expect, it, vi } from "vitest";
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
    readDaemonInstance: vi.fn(async () => null),
    runExternalCliJsonCommand: vi.fn(),
    resolveBundledDaemonRuntime: vi.fn(),
    resolvePaseoAppDaemonRuntime: vi.fn(),
    logInfo: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), getVersion: vi.fn(() => "1.0.0"), isPackaged: true },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: { info: mocks.logInfo, error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@getpaseo/server/daemon-control", () => ({
  resolvePaseoHome: vi.fn(() => "/tmp/orchestra-test-home"),
  startDaemonInstance: mocks.startDaemonInstance,
  stopDaemonInstance: vi.fn(),
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

const { createDaemonCommandHandlers, launchWithBundledFallback, pickOrchestraDaemonRuntime } =
  await import("./daemon-manager.js");

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

beforeEach(() => {
  mocks.startDaemonInstance.mockReset();
  mocks.readDaemonInstance.mockReset();
  mocks.readDaemonInstance.mockResolvedValue(null);
  mocks.runExternalCliJsonCommand.mockReset();
  mocks.resolveBundledDaemonRuntime.mockReset();
  mocks.resolvePaseoAppDaemonRuntime.mockReset();
});

describe("pickOrchestraDaemonRuntime", () => {
  it("picks the installed Paseo.app runtime when its server is newer", () => {
    const bundled = runtime("bundled", "0.8.0");
    const paseoApp = runtime("paseo-app", "0.9.2");
    expect(pickOrchestraDaemonRuntime(bundled, () => paseoApp)).toBe(paseoApp);
  });

  it("keeps the bundled runtime when Paseo.app is absent, older or unreadable", () => {
    const bundled = runtime("bundled", "0.9.2");
    expect(pickOrchestraDaemonRuntime(bundled, () => null)).toBe(bundled);
    expect(pickOrchestraDaemonRuntime(bundled, () => runtime("paseo-app", "0.8.0"))).toBe(bundled);
    expect(
      pickOrchestraDaemonRuntime(bundled, () => {
        throw new Error("bad package.json");
      }),
    ).toBe(bundled);
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
  it("with nothing listening, tries Paseo.app's newer server and falls back to the bundled one", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({ localDaemon: "stopped", serverId: "" });
    mocks.resolveBundledDaemonRuntime.mockReturnValue(runtime("bundled", "0.8.0"));
    mocks.resolvePaseoAppDaemonRuntime.mockReturnValue(runtime("paseo-app", "0.9.2"));
    mocks.startDaemonInstance
      .mockRejectedValueOnce(new Error("helper crashed"))
      .mockResolvedValueOnce({ spawned: true });

    await createDaemonCommandHandlers().start_desktop_daemon();

    expect(launchedCommands()).toEqual(["/paseo-app/node", "/bundled/node"]);
    expect(mocks.startDaemonInstance.mock.calls[1][0]).toMatchObject({
      env: { PASEO_CLI: "/bundled/bin/paseo" },
      desktopManaged: true,
    });
  });

  it("reuses a daemon that is already listening and launches nothing", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      serverId: "srv",
      listen: "127.0.0.1:6767",
      pid: 42,
      daemonVersion: "0.9.2",
      desktopManaged: true,
    });
    await createDaemonCommandHandlers().start_desktop_daemon();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.resolvePaseoAppDaemonRuntime).not.toHaveBeenCalled();
  });
});
