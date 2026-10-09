import path from "node:path";
import { constants as osConstants } from "node:os";
import { z } from "zod";

// `paseo maestro-claude -- <args>`: the `claude` that Orchestra puts in the
// terminal (terminal-bin shim). Fleet credentials go to the child process only,
// never to this process's env, the shell, or the screen.

export const MAESTRO_PLUGIN_ID = "figmenta-sessions";
export const TERMINAL_LAUNCH_METHOD = "maestro.terminal_launch";
export const TERMINAL_END_METHOD = "maestro.terminal_end";
export const TERMINAL_LAUNCH_TIMEOUT_MS = 30_000;
const TERMINAL_END_TIMEOUT_MS = 10_000;

export const PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  "--version",
  "-v",
  "--help",
  "-h",
  "doctor",
  "config",
  "mcp",
  "migrate-installer",
  "setup-token",
]);

export const SELF_UPDATE_COMMANDS: ReadonlySet<string> = new Set(["update", "upgrade", "install"]);

export const GOVERNED_FLAGS: readonly string[] = [
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
  "--plugin-url",
  "--add-dir",
  "--agents",
  "--agent",
  "--fallback-model",
  "--bg",
  "--background",
  "--cloud",
  "--remote-control",
  "--teleport",
];

// Set by the CLI launcher: never inherited by `claude`, in any branch. Same keys as
// RUNTIME_CONTROL_ENV_KEYS in packages/server/src/server/paseo-env.ts (not exported), plus PASEO_CLI.
export const LAUNCHER_ENV_KEYS: readonly string[] = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "PASEO_CLI",
  "ESBUILD_BINARY_PATH",
];

/** A copy of `env` without the launcher's keys. */
export function withoutLauncherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of LAUNCHER_ENV_KEYS) delete copy[key];
  return copy;
}

// Fleet branch: the shell's own Claude Code settings (a base URL, an API key, Bedrock, another
// config dir) must neither receive the fleet token nor replace it.
const FLEET_STRIPPED_ENV_PREFIX = /^(ANTHROPIC_|CLAUDE_CODE_)/;
const FLEET_STRIPPED_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLAUDE_CONFIG_DIR",
  "AWS_BEARER_TOKEN_BEDROCK",
]);
const FLEET_KEPT_ENV_KEYS: ReadonlySet<string> = new Set(["CLAUDE_CODE_GIT_BASH_PATH"]);

/** The base env of a fleet child, before Maestro's `env` is applied. */
export function fleetBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const stripped =
      !FLEET_KEPT_ENV_KEYS.has(key) &&
      (FLEET_STRIPPED_ENV_PREFIX.test(key) || FLEET_STRIPPED_ENV_KEYS.has(key));
    if (!stripped) base[key] = value;
  }
  return base;
}

/** cmd.exe runs a .cmd/.bat: an argument with a line break cannot reach it intact. */
function isWindowsBatch(claude: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(claude);
}

export const MESSAGES = {
  notInstalled: "Claude Code is not installed. Orchestra installs it at the next check.",
  selfUpdate: "Orchestra keeps Claude Code up to date.",
  governed: (flag: string) => `${flag} is set by Maestro and cannot be changed here.`,
  windowsBatchMultiline: "this Claude Code copy cannot take Maestro's settings on Windows",
  failed: (reason: string) =>
    `Maestro could not start Claude Code here: ${reason}. Use the chat, or ask the workspace owner.`,
};

const TerminalLaunchResponseSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("own") }),
  z.object({
    mode: z.literal("fleet"),
    agentId: z.string().min(1),
    env: z.record(z.string(), z.string()),
    argv: z.array(z.string()),
  }),
  z.object({ mode: z.literal("refused"), reason: z.string().optional(), message: z.string() }),
]);

export type TerminalLaunchResponse = z.infer<typeof TerminalLaunchResponseSchema>;

export interface MaestroRpcClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface ChildHandle {
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // Windows .cmd/.bat only: the command line is already quoted for cmd.exe.
  windowsVerbatimArguments?: boolean;
}

export interface MaestroClaudeFs {
  isFile(filePath: string): boolean;
  isExecutable(filePath: string): boolean;
  realpath(filePath: string): string;
}

export interface MaestroClaudeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  fs: MaestroClaudeFs;
  connect(): Promise<MaestroRpcClient>;
  spawn(request: SpawnRequest): ChildHandle;
  onSignal(signal: NodeJS.Signals, handler: () => void): () => void;
  stdout(text: string): void;
  stderr(text: string): void;
  launchTimeoutMs?: number;
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function pathEnvValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  return env[key] ?? "";
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const left = pathApi.resolve(a);
  const right = pathApi.resolve(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function safeRealpath(fs: MaestroClaudeFs, filePath: string): string {
  try {
    return fs.realpath(filePath);
  } catch {
    return filePath;
  }
}

function claudeNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
}

function isLaunchable(fs: MaestroClaudeFs, filePath: string, platform: NodeJS.Platform): boolean {
  if (!fs.isFile(filePath)) return false;
  return platform === "win32" ? true : fs.isExecutable(filePath);
}

/**
 * The `claude` to start: Orchestra's engine-bin copy when ORCHESTRA_ENGINE_BIN is set,
 * otherwise the first `claude` on PATH that is not in ORCHESTRA_TERMINAL_BIN (never this shim).
 */
export function resolveClaudeExecutable(deps: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fs: MaestroClaudeFs;
}): string | null {
  const { env, platform, fs } = deps;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const engineBin = envValue(env, "ORCHESTRA_ENGINE_BIN");
  if (engineBin) {
    for (const name of claudeNames(platform)) {
      const candidate = pathApi.join(engineBin, name);
      if (isLaunchable(fs, candidate, platform)) return candidate;
    }
    return null;
  }

  // Never Orchestra's own folders, before or after realpath: terminal-bin holds this very shim,
  // engine-bin the chats' link.
  const excluded = [envValue(env, "ORCHESTRA_TERMINAL_BIN"), envValue(env, "ORCHESTRA_ENGINE_BIN")]
    .filter((dir): dir is string => dir !== null)
    .flatMap((dir) => [dir, safeRealpath(fs, dir)]);
  const isExcluded = (dir: string) => excluded.some((other) => samePath(dir, other, platform));
  const delimiter = platform === "win32" ? ";" : ":";
  for (const rawEntry of pathEnvValue(env).split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (isExcluded(entry) || isExcluded(safeRealpath(fs, entry))) continue;
    for (const name of claudeNames(platform)) {
      const candidate = pathApi.join(entry, name);
      if (!isLaunchable(fs, candidate, platform)) continue;
      if (isExcluded(pathApi.dirname(safeRealpath(fs, candidate)))) continue;
      return candidate;
    }
  }
  return null;
}

/** The governed flag in `args`, if any (`--flag` or `--flag=value`). */
export function findGovernedFlag(args: readonly string[]): string | null {
  for (const arg of args) {
    for (const flag of GOVERNED_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
    }
  }
  return null;
}

// cmd.exe quoting for .cmd/.bat targets (same rules as cross-spawn).
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

function escapeCmdArgument(arg: string): string {
  let escaped = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  // A .cmd target re-parses its arguments: escape the meta chars twice.
  return escaped.replace(CMD_META_CHARS, "^$1").replace(CMD_META_CHARS, "^$1");
}

export function buildSpawnRequest(input: {
  claude: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): SpawnRequest {
  const { claude, args, env, platform } = input;
  if (isWindowsBatch(claude, platform)) {
    const comSpec = envValue(env, "ComSpec") ?? envValue(env, "COMSPEC") ?? "cmd.exe";
    const commandLine = [escapeCmdCommand(path.win32.normalize(claude))]
      .concat(args.map(escapeCmdArgument))
      .join(" ");
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      env,
      windowsVerbatimArguments: true,
    };
  }
  return { command: claude, args, env };
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = (osConstants.signals as Record<string, number | undefined>)[signal];
  return number ? 128 + number : 1;
}

async function runChild(deps: MaestroClaudeDeps, request: SpawnRequest): Promise<number> {
  let child: ChildHandle;
  try {
    child = deps.spawn(request);
  } catch (error) {
    return reportSpawnError(deps, error);
  }
  const unsubscribers = FORWARDED_SIGNALS.map((signal) =>
    deps.onSignal(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // child already gone
      }
    }),
  );
  try {
    return await new Promise<number>((resolve) => {
      let settled = false;
      child.onExit((code, signal) => {
        if (settled) return;
        settled = true;
        resolve(code ?? signalExitCode(signal));
      });
      child.onError((error) => {
        if (settled) return;
        settled = true;
        resolve(reportSpawnError(deps, error));
      });
    });
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
  }
}

function reportSpawnError(deps: MaestroClaudeDeps, error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    deps.stderr(`${MESSAGES.notInstalled}\n`);
    return 127;
  }
  deps.stderr(`Claude Code could not start: ${describeError(error)}\n`);
  return 1;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/\.+$/, "");
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message.replace(/\.+$/, "");
  }
  return String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} seconds`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestTerminalLaunch(deps: MaestroClaudeDeps): Promise<TerminalLaunchResponse> {
  const timeoutMs = deps.launchTimeoutMs ?? TERMINAL_LAUNCH_TIMEOUT_MS;
  const connecting = deps.connect();
  connecting.catch(() => undefined);
  const attempt = connecting.then(async (client) => {
    // The connection is not kept open for the length of the session.
    try {
      const output = await client.invokePluginRpc(MAESTRO_PLUGIN_ID, TERMINAL_LAUNCH_METHOD, {
        terminalId: deps.env.PASEO_TERMINAL_ID ?? null,
        pid: deps.pid,
      });
      const parsed = TerminalLaunchResponseSchema.safeParse(output);
      if (!parsed.success) throw new Error("unexpected answer from Maestro");
      return parsed.data;
    } finally {
      await client.close().catch(() => {});
    }
  });
  attempt.catch(() => undefined);
  try {
    return await withTimeout(attempt, timeoutMs);
  } catch (error) {
    void connecting.then(
      (client) => client.close().catch(() => {}),
      () => undefined,
    );
    throw error;
  }
}

async function endTerminalSession(deps: MaestroClaudeDeps, agentId: string): Promise<void> {
  try {
    await withTimeout(
      (async () => {
        const client = await deps.connect();
        try {
          await client.invokePluginRpc(MAESTRO_PLUGIN_ID, TERMINAL_END_METHOD, { agentId });
        } finally {
          await client.close().catch(() => {});
        }
      })(),
      TERMINAL_END_TIMEOUT_MS,
    );
  } catch {
    // ignored: the plugin also expires terminals whose pid is gone
  }
}

/** Returns the exit code of `paseo maestro-claude -- <args>`. */
export async function runMaestroClaude(args: string[], deps: MaestroClaudeDeps): Promise<number> {
  const first = args[0];

  if (first !== undefined && SELF_UPDATE_COMMANDS.has(first)) {
    deps.stdout(`${MESSAGES.selfUpdate}\n`);
    return 0;
  }

  if (first !== undefined && PASSTHROUGH_COMMANDS.has(first)) {
    const claude = resolveClaudeExecutable(deps);
    if (!claude) {
      deps.stderr(`${MESSAGES.notInstalled}\n`);
      return 127;
    }
    return runChild(
      deps,
      buildSpawnRequest({ claude, args, env: deps.env, platform: deps.platform }),
    );
  }

  const governed = findGovernedFlag(args);
  if (governed) {
    deps.stderr(`${MESSAGES.governed(governed)}\n`);
    return 2;
  }

  const claude = resolveClaudeExecutable(deps);
  if (!claude) {
    deps.stderr(`${MESSAGES.notInstalled}\n`);
    return 127;
  }

  let response: TerminalLaunchResponse;
  try {
    response = await requestTerminalLaunch(deps);
  } catch (error) {
    deps.stderr(`${MESSAGES.failed(describeError(error))}\n`);
    return 1;
  }

  if (response.mode === "refused") {
    deps.stderr(`${response.message}\n`);
    return 1;
  }

  if (response.mode === "own") {
    return runChild(
      deps,
      buildSpawnRequest({ claude, args, env: deps.env, platform: deps.platform }),
    );
  }

  // Fleet: the credentials live only in the child's env, over a base without the shell's own
  // Claude Code settings.
  const childEnv: NodeJS.ProcessEnv = { ...fleetBaseEnv(deps.env), ...response.env };
  try {
    if (isWindowsBatch(claude, deps.platform) && response.argv.some((arg) => /[\r\n]/.test(arg))) {
      deps.stderr(`${MESSAGES.failed(MESSAGES.windowsBatchMultiline)}\n`);
      return 1;
    }
    return await runChild(
      deps,
      buildSpawnRequest({
        claude,
        // Maestro's argv first: a person's `--`, or an option left without its value at the end
        // (`--session-id`), cannot swallow or shift Maestro's settings.
        args: [...response.argv, ...args],
        env: childEnv,
        platform: deps.platform,
      }),
    );
  } finally {
    await endTerminalSession(deps, response.agentId);
  }
}
