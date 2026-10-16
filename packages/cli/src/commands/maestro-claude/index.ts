import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isatty } from "node:tty";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";
import {
  classifyStdin,
  needsConsoleInput,
  runMaestroClaude,
  withoutLauncherEnv,
  type ChildHandle,
  type MaestroClaudeDeps,
  type SpawnRequest,
  type StdinKind,
  type StdinStat,
} from "./maestro-claude.js";

function stdinKind(): StdinKind {
  let stat: StdinStat | null = null;
  try {
    stat = fstatSync(0);
  } catch {
    // no handle behind fd 0
  }
  return classifyStdin(isatty(0), stat);
}

// Node opens the console's input by its device path; a bare "CONIN$" is ENOENT (measured).
const CONSOLE_INPUT = "\\\\.\\CONIN$";

/** The console's input for the child (see needsConsoleInput), or null to inherit fd 0. */
function openConsoleInput(): number | null {
  if (!needsConsoleInput(process.platform, stdinKind(), isatty(1) || isatty(2))) return null;
  try {
    return openSync(CONSOLE_INPUT, "r+");
  } catch {
    return null;
  }
}

function spawnChild(request: SpawnRequest): ChildHandle {
  const consoleInput = openConsoleInput();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(request.command, request.args, {
      env: request.env,
      shell: false,
      stdio: [consoleInput ?? "inherit", "inherit", "inherit"],
      windowsVerbatimArguments: request.windowsVerbatimArguments,
    });
  } finally {
    // The child has its own copy of the handle once spawn returns.
    if (consoleInput !== null) {
      try {
        closeSync(consoleInput);
      } catch {
        // a leaked handle is better than reporting a running claude as not started
      }
    }
  }
  return {
    kill: (signal) => {
      child.kill(signal);
    },
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onError: (listener) => {
      child.once("error", listener);
    },
  };
}

export function createMaestroClaudeDeps(): MaestroClaudeDeps {
  return {
    // A copy without the launcher's own keys (ELECTRON_RUN_AS_NODE and the rest): every branch's
    // child starts from it, and process.env is never written.
    env: withoutLauncherEnv(process.env),
    platform: process.platform,
    pid: process.pid,
    fs: {
      isFile: (filePath) => {
        try {
          return statSync(filePath).isFile();
        } catch {
          return false;
        }
      },
      isExecutable: (filePath) => {
        try {
          accessSync(filePath, fsConstants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      realpath: (filePath) => realpathSync(filePath),
    },
    // Default target: the terminal's env carries the daemon's PASEO_HOME/PASEO_HOST.
    connect: () => connectToDaemon({ target: selectDaemonTarget({}, process.env) }),
    spawn: spawnChild,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

export function createMaestroClaudeCommand(): Command {
  return new Command("maestro-claude")
    .description("Start Claude Code in an Orchestra terminal (used by the terminal `claude` shim)")
    .argument("[args...]", "arguments for claude, after --")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions()
    .action(async (args: string[] | undefined) => {
      const exitCode = await runMaestroClaude(args ?? [], createMaestroClaudeDeps());
      process.exit(exitCode);
    });
}
