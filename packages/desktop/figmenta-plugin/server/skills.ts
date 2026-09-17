/**
 * Maestro skills on disk, under ~/.claude/skills/<slug>/.
 *
 * The plugin owns only the directories it marked with `.maestro-managed`. A
 * directory without the marker is the user's own skill and is never written to,
 * never deleted — at worst it is reported as skipped.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MARKER = ".maestro-managed";
const SLUG = /^[a-z0-9-]{2,40}$/;

export interface SkillSpec {
  readonly slug: string;
  readonly name?: string | undefined;
  readonly body_md?: string | undefined;
  readonly summary?: string | undefined;
  readonly role?: string | undefined;
}

export interface SyncResult {
  readonly written: string[];
  readonly removed: string[];
  /** Slugs that collide with a directory the plugin does not own, or invalid slugs. */
  readonly skipped: string[];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function skillDescription(skill: SkillSpec): string {
  const candidates = [skill.summary, skill.role, skill.name, skill.slug];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return oneLine(candidate);
  }
  return skill.slug;
}

export function renderSkillFile(skill: SkillSpec): string {
  const description = skillDescription(skill).replace(/"/g, "'");
  const front = ["---", `name: ${skill.slug}`, `description: "${description}"`, "---", ""];
  return `${front.join("\n")}\n${(skill.body_md ?? "").trim()}\n`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function syncSkills(dir: string, skills: readonly SkillSpec[]): Promise<SyncResult> {
  const written: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  await mkdir(dir, { recursive: true });

  const wanted = new Set<string>();
  for (const skill of skills) {
    if (!SLUG.test(skill.slug)) {
      skipped.push(skill.slug);
      continue;
    }
    const target = join(dir, skill.slug);
    if ((await isDirectory(target)) && !(await exists(join(target, MARKER)))) {
      skipped.push(skill.slug); // pre-existing, not ours
      continue;
    }
    wanted.add(skill.slug);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), renderSkillFile(skill), "utf8");
    await writeFile(
      join(target, MARKER),
      `${JSON.stringify({ slug: skill.slug, at: new Date().toISOString() })}\n`,
      "utf8",
    );
    written.push(skill.slug);
  }

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (wanted.has(entry.name)) continue;
    const target = join(dir, entry.name);
    if (!(await exists(join(target, MARKER)))) continue; // not ours: leave it alone
    await rm(target, { recursive: true, force: true });
    removed.push(entry.name);
  }

  return { written, removed, skipped };
}
