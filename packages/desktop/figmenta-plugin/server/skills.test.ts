import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKER, renderSkillFile, syncSkills } from "./skills";

async function tempSkillsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "maestro-skills-"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("renderSkillFile", () => {
  it("writes the name verbatim in the frontmatter, with a one-line description", () => {
    const file = renderSkillFile({
      slug: "maestro-planner",
      name: "Planner",
      summary: "Plans your\nweek",
      body_md: "Do the thing.",
    });
    expect(file).toContain("name: Planner");
    expect(file).toContain('description: "Plans your week"');
    expect(file.trimEnd().endsWith("Do the thing.")).toBe(true);
  });

  it("falls back to the slug when the skill carries no name", () => {
    expect(renderSkillFile({ slug: "maestro-editor", body_md: "Edit." })).toContain(
      "name: maestro-editor",
    );
  });
});

describe("syncSkills", () => {
  it("writes the skill, its marker, and reports it", async () => {
    const dir = await tempSkillsDir();
    const result = await syncSkills(dir, [{ slug: "maestro-planner", body_md: "Plan." }]);
    expect(result.written).toEqual(["maestro-planner"]);
    expect(await readFile(join(dir, "maestro-planner", "SKILL.md"), "utf8")).toContain("Plan.");
    expect(await exists(join(dir, "maestro-planner", MARKER))).toBe(true);
  });

  it("removes a managed skill that left the profile", async () => {
    const dir = await tempSkillsDir();
    await syncSkills(dir, [{ slug: "maestro-planner" }, { slug: "maestro-editor" }]);
    const result = await syncSkills(dir, [{ slug: "maestro-planner" }]);
    expect(result.removed).toEqual(["maestro-editor"]);
    expect(await exists(join(dir, "maestro-editor"))).toBe(false);
    expect(await exists(join(dir, "maestro-planner"))).toBe(true);
  });

  it("never touches a directory without the marker", async () => {
    const dir = await tempSkillsDir();
    await mkdir(join(dir, "mine"), { recursive: true });
    await writeFile(join(dir, "mine", "SKILL.md"), "hand written", "utf8");
    await mkdir(join(dir, "maestro-planner"), { recursive: true });
    await writeFile(join(dir, "maestro-planner", "SKILL.md"), "hand written too", "utf8");

    const result = await syncSkills(dir, [{ slug: "maestro-planner", body_md: "Plan." }]);

    expect(result.skipped).toEqual(["maestro-planner"]);
    expect(await readFile(join(dir, "maestro-planner", "SKILL.md"), "utf8")).toBe(
      "hand written too",
    );
    expect(await readFile(join(dir, "mine", "SKILL.md"), "utf8")).toBe("hand written");
  });

  it("writes the base skill under its lowercase slug, keeping the persona name cased", async () => {
    const dir = await tempSkillsDir();
    const result = await syncSkills(dir, [
      { slug: "pluto", name: "Pluto", body_md: "When invoked, give the user a short briefing." },
    ]);
    expect(result.written).toEqual(["pluto"]);
    const file = await readFile(join(dir, "pluto", "SKILL.md"), "utf8");
    expect(file.split("\n").slice(0, 4)).toEqual([
      "---",
      "name: Pluto",
      'description: "Pluto"',
      "---",
    ]);
    expect(file).toContain("When invoked, give the user a short briefing.");
    expect(await exists(join(dir, "pluto", MARKER))).toBe(true);
  });

  it("a persona rename removes the old base-skill directory", async () => {
    const dir = await tempSkillsDir();
    await syncSkills(dir, [{ slug: "maestro", name: "Maestro", body_md: "Brief." }]);
    const result = await syncSkills(dir, [{ slug: "pluto", name: "Pluto", body_md: "Brief." }]);
    expect(result.removed).toEqual(["maestro"]);
    expect(await exists(join(dir, "maestro"))).toBe(false);
  });

  it("refuses an invalid slug", async () => {
    const dir = await tempSkillsDir();
    const result = await syncSkills(dir, [{ slug: "../escape" }]);
    expect(result.skipped).toEqual(["../escape"]);
    expect(result.written).toEqual([]);
  });
});
