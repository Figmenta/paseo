import { pathToFileURL } from "node:url";
import { resolvePassthroughCliEntrypoint } from "./entrypoints.js";

const DESKTOP_CLI_ENV = "PASEO_DESKTOP_CLI";
const IGNORED_ARG_PREFIXES = ["-psn_", "--class=", "--no-sandbox", "--remote-debugging-port="];
// Figmenta fork: after a silent Windows update the NSIS installer relaunches the app as
// `Orchestra.exe --updated`. Read as CLI arguments, that launch ran `paseo --updated` and
// exited: the update installed and Orchestra never came back (CI run 36404199037, the
// relaunched 1.0.3/1.0.4 logged "app startup" and nothing else). It is a GUI launch.
const IGNORED_EXACT_ARGS = new Set(["--updated"]);

export type PassthroughCliRunner = (argv: string[]) => Promise<number>;

export function parsePassthroughCliArgs(input: {
  argv: string[];
  isDefaultApp: boolean;
  forceCli: boolean;
}): string[] | null {
  const startIndex = input.isDefaultApp ? 2 : 1;
  const effective: string[] = [];

  for (const arg of input.argv.slice(startIndex)) {
    if (
      IGNORED_EXACT_ARGS.has(arg) ||
      IGNORED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
    ) {
      continue;
    }
    effective.push(arg);
  }

  if (input.forceCli) {
    return effective;
  }

  return effective.length > 0 ? effective : null;
}

export function parsePassthroughCliArgsFromArgv(argv: string[]): string[] | null {
  return parsePassthroughCliArgs({
    argv,
    isDefaultApp: process.defaultApp,
    forceCli: process.env[DESKTOP_CLI_ENV] === "1",
  });
}

async function importPassthroughCliRunner(): Promise<PassthroughCliRunner> {
  const entrypoint = resolvePassthroughCliEntrypoint();
  const imported = (await import(pathToFileURL(entrypoint).href)) as {
    runCli?: unknown;
  };
  if (typeof imported.runCli !== "function") {
    throw new Error(`Passthrough CLI entrypoint did not export runCli: ${entrypoint}`);
  }
  return imported.runCli as PassthroughCliRunner;
}

export async function runPassthroughCli(
  args: string[],
  options: { runCli?: PassthroughCliRunner } = {},
): Promise<number> {
  const runCli = options.runCli ?? (await importPassthroughCliRunner());
  return await runCli(args);
}
