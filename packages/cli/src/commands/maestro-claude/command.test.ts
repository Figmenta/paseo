import { describe, expect, it } from "vitest";
import { createCli } from "../../cli.js";
import { createCliParseArgv } from "../../run.js";

async function parsedArgs(argv: string[]): Promise<string[]> {
  const parseArgv = createCliParseArgv({ argv, cwd: process.cwd() });
  if (!Array.isArray(parseArgv)) throw new Error("expected a CLI invocation");
  const program = createCli();
  const command = program.commands.find((entry) => entry.name() === "maestro-claude");
  if (!command) throw new Error("maestro-claude is not registered");
  let seen: string[] | null = null;
  command.action((args: string[] | undefined) => {
    seen = args ?? [];
  });
  await program.parseAsync(parseArgv, { from: "node" });
  if (seen === null) throw new Error("action not called");
  return seen;
}

describe("paseo maestro-claude command", () => {
  it("is registered and hidden from the help", () => {
    const program = createCli();
    expect(program.commands.some((entry) => entry.name() === "maestro-claude")).toBe(true);
    expect(program.helpInformation()).not.toContain("maestro-claude");
  });

  it.each([
    [["--", "--version"], ["--version"]],
    [["--", "-v"], ["-v"]],
    [["--", "--help"], ["--help"]],
    [
      ["--", "-q", "--model=x"],
      ["-q", "--model=x"],
    ],
    [
      ["--", "--json", "-p", "hi", "--host", "h"],
      ["--json", "-p", "hi", "--host", "h"],
    ],
    [
      ["--", "--", "-p"],
      ["--", "-p"],
    ],
    [["--"], []],
  ])("passes everything after -- to claude: %j", async (input, expected) => {
    expect(await parsedArgs(["maestro-claude", ...input])).toEqual(expected);
  });
});
