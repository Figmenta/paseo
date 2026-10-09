import { afterEach, describe, expect, it } from "vitest";
import {
  GOVERNED_FLAGS,
  MESSAGES,
  buildSpawnRequest,
  findGovernedFlag,
  resolveClaudeExecutable,
  runMaestroClaude,
  type ChildHandle,
  type MaestroClaudeDeps,
  type MaestroClaudeFs,
  type SpawnRequest,
} from "./maestro-claude.js";

interface RpcCall {
  pluginId: string;
  method: string;
  input: unknown;
}

interface FakeChild {
  handle: ChildHandle;
  killed: NodeJS.Signals[];
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  fail(error: Error): void;
}

function createFakeChild(): FakeChild {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const killed: NodeJS.Signals[] = [];
  return {
    killed,
    handle: {
      kill: (signal) => {
        killed.push(signal);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      onError: (listener) => {
        errorListeners.push(listener);
      },
    },
    exit: (code, signal = null) => {
      for (const listener of exitListeners) listener(code, signal);
    },
    fail: (error) => {
      for (const listener of errorListeners) listener(error);
    },
  };
}

function fakeFs(files: Record<string, string> = {}): MaestroClaudeFs {
  // files: path -> realpath (identity when equal)
  return {
    isFile: (filePath) => filePath in files,
    isExecutable: (filePath) => filePath in files,
    realpath: (filePath) => files[filePath] ?? filePath,
  };
}

interface Harness {
  deps: MaestroClaudeDeps;
  rpcCalls: RpcCall[];
  spawns: SpawnRequest[];
  children: FakeChild[];
  stdout: string[];
  stderr: string[];
  signalHandlers: Map<NodeJS.Signals, Set<() => void>>;
  closes: number;
}

function createHarness(options: {
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  launch?: (input: unknown) => unknown;
  end?: (input: unknown) => unknown;
  connectError?: unknown;
  childExitCode?: number | null;
  childSignal?: NodeJS.Signals | null;
  launchTimeoutMs?: number;
  platform?: NodeJS.Platform;
}): Harness {
  const harness: Harness = {
    deps: undefined as unknown as MaestroClaudeDeps,
    rpcCalls: [],
    spawns: [],
    children: [],
    stdout: [],
    stderr: [],
    signalHandlers: new Map(),
    closes: 0,
  };
  const env: NodeJS.ProcessEnv = options.env ?? {
    PATH: "/usr/bin",
    ORCHESTRA_ENGINE_BIN: "/engine-bin",
    ORCHESTRA_TERMINAL_BIN: "/terminal-bin",
    PASEO_TERMINAL_ID: "term-1",
    HOME: "/home/person",
  };
  harness.deps = {
    env,
    platform: options.platform ?? "darwin",
    pid: 4242,
    fs: fakeFs(options.files ?? { "/engine-bin/claude": "/engine-bin/claude" }),
    launchTimeoutMs: options.launchTimeoutMs,
    connect: async () => {
      if (options.connectError !== undefined) throw options.connectError;
      return {
        invokePluginRpc: async (pluginId, method, input) => {
          harness.rpcCalls.push({ pluginId, method, input });
          if (method === "maestro.terminal_launch") {
            return options.launch ? options.launch(input) : { mode: "own" };
          }
          return options.end ? options.end(input) : { ok: true };
        },
        close: async () => {
          harness.closes += 1;
        },
      };
    },
    spawn: (request) => {
      harness.spawns.push(request);
      const child = createFakeChild();
      harness.children.push(child);
      // Exit on the next tick, after the runner has subscribed.
      setTimeout(
        () =>
          child.exit(
            options.childExitCode === undefined ? 0 : options.childExitCode,
            options.childSignal ?? null,
          ),
        0,
      );
      return child.handle;
    },
    onSignal: (signal, handler) => {
      const set = harness.signalHandlers.get(signal) ?? new Set();
      set.add(handler);
      harness.signalHandlers.set(signal, set);
      return () => set.delete(handler);
    },
    stdout: (text) => harness.stdout.push(text),
    stderr: (text) => harness.stderr.push(text),
  };
  return harness;
}

const FLEET_RESPONSE = {
  mode: "fleet",
  agentId: "6f1c1f9e-1d3a-4a8e-9f3e-2b8c6f0d1a11",
  env: {
    CLAUDE_CONFIG_DIR: "/maestro/class/normal",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret",
    MAESTRO_MCP_TOKEN: "mcp-secret",
    MAESTRO_USER: "person@example.com",
    PASEO_AGENT_ID: "6f1c1f9e-1d3a-4a8e-9f3e-2b8c6f0d1a11",
  },
  argv: ["--model", "claude-opus", "--tools", "Read,Edit", "--effort", "high"],
};

const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
afterEach(() => {
  if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
  delete process.env.MAESTRO_MCP_TOKEN;
});

describe("maestro-claude passthrough", () => {
  it.each([
    "--version",
    "-v",
    "--help",
    "-h",
    "doctor",
    "config",
    "mcp",
    "migrate-installer",
    "setup-token",
  ])("starts claude for %s without any RPC, env unchanged", async (first) => {
    const harness = createHarness({ launch: () => FLEET_RESPONSE });
    const code = await runMaestroClaude([first, "extra"], harness.deps);

    expect(code).toBe(0);
    expect(harness.rpcCalls).toEqual([]);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]).toEqual({
      command: "/engine-bin/claude",
      args: [first, "extra"],
      env: harness.deps.env,
    });
  });

  it.each(["update", "install"])("%s prints the message and exits 0", async (first) => {
    const harness = createHarness({});
    const code = await runMaestroClaude([first], harness.deps);

    expect(code).toBe(0);
    expect(harness.stdout.join("")).toBe(`${MESSAGES.selfUpdate}\n`);
    expect(harness.rpcCalls).toEqual([]);
    expect(harness.spawns).toEqual([]);
  });
});

// Literal list from the contract (V3, CLI): the test must not derive it from the code.
const CONTRACT_GOVERNED_FLAGS = [
  "--model",
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--mcp-config",
  "--strict-mcp-config",
  "--managed-settings",
  "--settings",
  "--setting-sources",
  "--effort",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--system-prompt",
  "--system-prompt-file",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--plugin-dir",
  "--add-dir",
];

describe("maestro-claude governed flags", () => {
  it.each(CONTRACT_GOVERNED_FLAGS.flatMap((flag) => [[flag], [`${flag}=value`]]))(
    "refuses %s before any RPC",
    async (arg) => {
      const flag = arg.split("=")[0];
      const harness = createHarness({ launch: () => FLEET_RESPONSE });
      const code = await runMaestroClaude(["-p", "hello", arg, "x"], harness.deps);

      expect(code).toBe(2);
      expect(harness.stderr.join("")).toBe(
        `${flag} is set by Maestro and cannot be changed here.\n`,
      );
      expect(harness.rpcCalls).toEqual([]);
      expect(harness.spawns).toEqual([]);
    },
  );

  it("covers exactly the contract list", () => {
    expect([...GOVERNED_FLAGS].sort()).toEqual([...CONTRACT_GOVERNED_FLAGS].sort());
  });

  it("does not mistake a longer flag for a governed one", () => {
    expect(findGovernedFlag(["--model-picker", "--settingsfoo"])).toBeNull();
    expect(findGovernedFlag(["--settings-x"])).toBeNull();
    expect(findGovernedFlag(["--model"])).toBe("--model");
    expect(findGovernedFlag(["--model=opus"])).toBe("--model");
  });
});

describe("maestro-claude fleet", () => {
  it("asks Maestro with the terminal id and pid", async () => {
    const harness = createHarness({ launch: () => FLEET_RESPONSE });
    await runMaestroClaude(["-p", "say ok"], harness.deps);

    expect(harness.rpcCalls[0]).toEqual({
      pluginId: "figmenta-sessions",
      method: "maestro.terminal_launch",
      input: { terminalId: "term-1", pid: 4242 },
    });
  });

  it("sends a null terminal id when PASEO_TERMINAL_ID is missing", async () => {
    const harness = createHarness({
      env: { PATH: "/usr/bin", ORCHESTRA_ENGINE_BIN: "/engine-bin" },
    });
    await runMaestroClaude([], harness.deps);

    expect(harness.rpcCalls[0]?.input).toEqual({ terminalId: null, pid: 4242 });
  });

  it("puts the credentials on the child only, person's args first, Maestro argv last", async () => {
    const harness = createHarness({ launch: () => FLEET_RESPONSE });
    const parentEnvBefore = { ...harness.deps.env };
    const processEnvBefore = { ...process.env };

    const code = await runMaestroClaude(["-p", "say ok"], harness.deps);

    expect(code).toBe(0);
    expect(harness.spawns).toHaveLength(1);
    const spawned = harness.spawns[0]!;
    expect(spawned.command).toBe("/engine-bin/claude");
    expect(spawned.args).toEqual(["-p", "say ok", ...FLEET_RESPONSE.argv]);
    expect(spawned.env).toEqual({ ...parentEnvBefore, ...FLEET_RESPONSE.env });
    // The parent keeps its env: no credential in this process, the shell, or the screen.
    expect(harness.deps.env).toEqual(parentEnvBefore);
    expect(harness.deps.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env).toEqual(processEnvBefore);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(originalOauth);
    expect(harness.stdout.join("") + harness.stderr.join("")).not.toContain("sk-ant-oat-secret");
  });

  it("returns the child's exit code and ends the session even on a non-zero exit", async () => {
    const harness = createHarness({ launch: () => FLEET_RESPONSE, childExitCode: 7 });
    const code = await runMaestroClaude([], harness.deps);

    expect(code).toBe(7);
    expect(harness.rpcCalls.map((call) => call.method)).toEqual([
      "maestro.terminal_launch",
      "maestro.terminal_end",
    ]);
    expect(harness.rpcCalls[1]?.input).toEqual({ agentId: FLEET_RESPONSE.agentId });
  });

  it("maps a signal exit to 128 + signal number", async () => {
    const harness = createHarness({
      launch: () => FLEET_RESPONSE,
      childExitCode: null,
      childSignal: "SIGTERM",
    });
    expect(await runMaestroClaude([], harness.deps)).toBe(143);
    expect(harness.rpcCalls.at(-1)?.method).toBe("maestro.terminal_end");
  });

  it("ignores terminal_end errors", async () => {
    const harness = createHarness({
      launch: () => FLEET_RESPONSE,
      end: () => {
        throw new Error("plugin gone");
      },
      childExitCode: 3,
    });
    expect(await runMaestroClaude([], harness.deps)).toBe(3);
    expect(harness.stderr).toEqual([]);
  });

  it("forwards SIGINT, SIGTERM and SIGHUP to the child, then unsubscribes", async () => {
    const harness = createHarness({ launch: () => FLEET_RESPONSE });
    let release: () => void = () => {};
    harness.deps.spawn = (request) => {
      harness.spawns.push(request);
      const child = createFakeChild();
      harness.children.push(child);
      release = () => child.exit(0);
      return child.handle;
    };
    const running = runMaestroClaude([], harness.deps);
    while (harness.children.length === 0) await new Promise((r) => setTimeout(r, 0));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      for (const handler of harness.signalHandlers.get(signal) ?? []) handler();
    }
    release();
    await running;

    expect(harness.children[0]?.killed).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      expect(harness.signalHandlers.get(signal)?.size ?? 0).toBe(0);
    }
  });
});

describe("maestro-claude own, refused, errors", () => {
  it("own: starts claude with the person's args only and env unchanged", async () => {
    const harness = createHarness({ launch: () => ({ mode: "own" }), childExitCode: 5 });
    const code = await runMaestroClaude(["-p", "hi"], harness.deps);

    expect(code).toBe(5);
    expect(harness.spawns[0]).toEqual({
      command: "/engine-bin/claude",
      args: ["-p", "hi"],
      env: harness.deps.env,
    });
    expect(harness.rpcCalls.map((call) => call.method)).toEqual(["maestro.terminal_launch"]);
  });

  it("refused: prints the message and exits 1", async () => {
    const harness = createHarness({
      launch: () => ({
        mode: "refused",
        reason: "launcher_not_allowed",
        message: "Your workspace owner has not enabled terminals for you.",
      }),
    });
    const code = await runMaestroClaude([], harness.deps);

    expect(code).toBe(1);
    expect(harness.stderr.join("")).toBe(
      "Your workspace owner has not enabled terminals for you.\n",
    );
    expect(harness.spawns).toEqual([]);
  });

  it("connection failure: generic message, exit 1, no claude", async () => {
    const harness = createHarness({
      connectError: { code: "DAEMON_UNREACHABLE", message: "Cannot connect to the daemon." },
    });
    const code = await runMaestroClaude([], harness.deps);

    expect(code).toBe(1);
    expect(harness.stderr.join("")).toBe(`${MESSAGES.failed("Cannot connect to the daemon")}\n`);
    expect(harness.spawns).toEqual([]);
  });

  it("RPC exception: generic message with the reason", async () => {
    const harness = createHarness({
      launch: () => {
        throw new Error("Plugin figmenta-sessions is not enabled");
      },
    });
    expect(await runMaestroClaude([], harness.deps)).toBe(1);
    expect(harness.stderr.join("")).toBe(
      "Maestro could not start Claude Code here: Plugin figmenta-sessions is not enabled. Use the chat, or ask the workspace owner.\n",
    );
    expect(harness.spawns).toEqual([]);
  });

  it("unexpected answer: generic message, exit 1", async () => {
    const harness = createHarness({ launch: () => ({ mode: "fleet", env: {} }) });
    expect(await runMaestroClaude([], harness.deps)).toBe(1);
    expect(harness.stderr.join("")).toContain("Maestro could not start Claude Code here:");
    expect(harness.spawns).toEqual([]);
  });

  it("timeout: generic message, exit 1, connection closed", async () => {
    const harness = createHarness({
      launch: () => new Promise(() => {}),
      launchTimeoutMs: 20,
    });
    expect(await runMaestroClaude([], harness.deps)).toBe(1);
    expect(harness.stderr.join("")).toMatch(/^Maestro could not start Claude Code here: .+\. Use/);
    expect(harness.spawns).toEqual([]);
  });

  it("no claude: message and 127, no RPC", async () => {
    const harness = createHarness({ files: {} });
    expect(await runMaestroClaude(["-p", "hi"], harness.deps)).toBe(127);
    expect(harness.stderr.join("")).toBe(`${MESSAGES.notInstalled}\n`);
    expect(harness.rpcCalls).toEqual([]);
  });

  it("spawn ENOENT: message and 127, session still ended", async () => {
    const harness = createHarness({ launch: () => FLEET_RESPONSE });
    harness.deps.spawn = (request) => {
      harness.spawns.push(request);
      const child = createFakeChild();
      setTimeout(() => child.fail(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
      return child.handle;
    };
    expect(await runMaestroClaude([], harness.deps)).toBe(127);
    expect(harness.rpcCalls.at(-1)?.method).toBe("maestro.terminal_end");
  });
});

describe("resolveClaudeExecutable", () => {
  it("uses the engine-bin copy when ORCHESTRA_ENGINE_BIN is set", () => {
    expect(
      resolveClaudeExecutable({
        env: { ORCHESTRA_ENGINE_BIN: "/engine-bin", PATH: "/usr/bin" },
        platform: "darwin",
        fs: fakeFs({ "/engine-bin/claude": "/engine-bin/claude", "/usr/bin/claude": "x" }),
      }),
    ).toBe("/engine-bin/claude");
  });

  it("on Windows prefers claude.exe, then claude.cmd", () => {
    const env = { ORCHESTRA_ENGINE_BIN: "C:\\engine-bin" };
    expect(
      resolveClaudeExecutable({
        env,
        platform: "win32",
        fs: fakeFs({ "C:\\engine-bin\\claude.exe": "", "C:\\engine-bin\\claude.cmd": "" }),
      }),
    ).toBe("C:\\engine-bin\\claude.exe");
    expect(
      resolveClaudeExecutable({
        env,
        platform: "win32",
        fs: fakeFs({ "C:\\engine-bin\\claude.cmd": "" }),
      }),
    ).toBe("C:\\engine-bin\\claude.cmd");
  });

  it("never picks its own shim from ORCHESTRA_TERMINAL_BIN", () => {
    const fs = fakeFs({
      "/terminal-bin/claude": "/terminal-bin/claude",
      "/home/person/.local/bin/claude": "/home/person/.local/bin/claude",
    });
    expect(
      resolveClaudeExecutable({
        env: {
          ORCHESTRA_TERMINAL_BIN: "/terminal-bin",
          PATH: "/terminal-bin:/home/person/.local/bin:/usr/bin",
        },
        platform: "darwin",
        fs,
      }),
    ).toBe("/home/person/.local/bin/claude");
  });

  it("skips a symlink that points back into terminal-bin, and returns null when only the shim exists", () => {
    const fs = fakeFs({
      "/terminal-bin/claude": "/terminal-bin/claude",
      "/opt/link/claude": "/terminal-bin/claude",
    });
    expect(
      resolveClaudeExecutable({
        env: { ORCHESTRA_TERMINAL_BIN: "/terminal-bin", PATH: "/terminal-bin:/opt/link" },
        platform: "darwin",
        fs,
      }),
    ).toBeNull();
  });

  it("the run never spawns the shim: 127 when PATH only has terminal-bin", async () => {
    const harness = createHarness({
      env: { ORCHESTRA_TERMINAL_BIN: "/terminal-bin", PATH: "/terminal-bin" },
      files: { "/terminal-bin/claude": "/terminal-bin/claude" },
    });
    expect(await runMaestroClaude(["--version"], harness.deps)).toBe(127);
    expect(harness.spawns).toEqual([]);
  });
});

describe("buildSpawnRequest", () => {
  it("spawns the executable directly", () => {
    expect(
      buildSpawnRequest({ claude: "/x/claude", args: ["-p", "a b"], env: {}, platform: "linux" }),
    ).toEqual({ command: "/x/claude", args: ["-p", "a b"], env: {} });
  });

  it("wraps a Windows .cmd in cmd.exe with quoted arguments", () => {
    const request = buildSpawnRequest({
      claude: "C:\\npm\\claude.cmd",
      args: ["-p", "a&b"],
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
    });
    expect(request.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(request.windowsVerbatimArguments).toBe(true);
    expect(request.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(request.args[3]).toContain("C:\\npm\\claude.cmd");
    expect(request.args[3]).toContain("a^^^&b");
  });
});
