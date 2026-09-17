/** ~/.paseo/figmenta-maestro.json — the connection, owner-readable only. */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EMPTY_STATE, MaestroStateSchema, type MaestroState } from "./profile";

export function statePath(): string {
  return join(homedir(), ".paseo", "figmenta-maestro.json");
}

export function denialsPath(): string {
  return join(homedir(), ".paseo", "figmenta-maestro-denials.jsonl");
}

export function skillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

/** A missing or corrupt file reads as "not connected": the daemon must still start. */
export async function loadState(path = statePath()): Promise<MaestroState> {
  try {
    const parsed = MaestroStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : { ...EMPTY_STATE };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function saveState(state: MaestroState, path = statePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
