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
  it("writes frontmatter with the slug as name and a one-line description", () => {
    const file = renderSkillFile({
      slug: "maestro-planner",
      name: "Planner",
      summary: "Plans your\nweek",
      body_md: "Do the thing.",
    });
    expect(file).toContain("name: maestro-planner");
    expect(file).toContain('description: "Plans your week"');
    expect(file.trimEnd().endsWith("Do the thing.")).toBe(true);
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
    expect(await readFile(join(dir, "maestro-planner", "SKILL.md"), "utf8")).toBe("hand written too");
    expect(await readFile(join(dir, "mine", "SKILL.md"), "utf8")).toBe("hand written");
  });

  it("refuses an invalid slug", async () => {
    const dir = await tempSkillsDir();
    const result = await syncSkills(dir, [{ slug: "../escape" }]);
    expect(result.skipped).toEqual(["../escape"]);
    expect(result.written).toEqual([]);
  });
});
