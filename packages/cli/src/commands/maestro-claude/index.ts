import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";
import {
  runMaestroClaude,
  type ChildHandle,
  type MaestroClaudeDeps,
  type SpawnRequest,
} from "./maestro-claude.js";

function spawnChild(request: SpawnRequest): ChildHandle {
  const child = spawn(request.command, request.args, {
    env: request.env,
    shell: false,
    stdio: "inherit",
    windowsVerbatimArguments: request.windowsVerbatimArguments,
  });
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
    env: process.env,
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
