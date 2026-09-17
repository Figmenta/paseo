/** Denied permissions, one JSON object per line, for the future usage digest. */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface DenialRecord {
  at: string;
  agentId: string;
  provider: string;
  cwd: string;
  requestId: string;
  message?: string | undefined;
  user?: string | undefined;
}

export async function appendDenial(path: string, record: DenialRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}
