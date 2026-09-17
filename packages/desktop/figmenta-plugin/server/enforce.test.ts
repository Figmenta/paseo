import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  enforceConfig,
  MAESTRO_BASE,
  splitProvider,
  type EnforceableConfig,
  type EnforceableProfile,
} from "./enforce";

const profile: EnforceableProfile = {
  models: ["claude-opus-5", "claude-sonnet-5"],
  modes: ["auto", "plan"],
  tools: ["orchestra", "memory"],
  custom_instructions: "Call me by my first name.",
  mcp: { url: "https://orchestra.figmenta.site/mcp/maestro", token: "orcm_secret" },
};

const base: EnforceableConfig = { provider: "claude", cwd: "/vault" };

describe("splitProvider", () => {
  it("reads the model out of a provider that carries one", () => {
    expect(splitProvider("claude/claude-opus-5")).toEqual({
      base: "claude",
      model: "claude-opus-5",
    });
  });
  it("returns no model for a bare provider", () => {
    expect(splitProvider("claude")).toEqual({ base: "claude", model: null });
  });
});

describe("enforceConfig", () => {
  it("keeps an allowed model and mode", () => {
    const result = enforceConfig(
      { ...base, model: "claude-sonnet-5", modeId: "plan" },
      profile,
    );
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.modeId).toBe("plan");
  });

  it("falls back to the first allowed model and rewrites the provider suffix", () => {
    const result = enforceConfig(
      { ...base, provider: "claude/claude-haiku-4-5", modeId: "auto" },
      profile,
    );
    expect(result.model).toBe("claude-opus-5");
    expect(result.provider).toBe("claude/claude-opus-5");
  });

  it("forces auto for a mode outside the profile, bypassPermissions included", () => {
    expect(enforceConfig({ ...base, modeId: "acceptEdits" }, profile).modeId).toBe("auto");
    expect(enforceConfig({ ...base, modeId: "bypassPermissions" }, profile).modeId).toBe("auto");
  });

  it("adds the maestro MCP server and keeps the ones already there", () => {
    const input: EnforceableConfig = {
      ...base,
      mcpServers: { other: { type: "stdio", command: "x" } },
    };
    const result = enforceConfig(input, profile);
    expect(result.mcpServers?.["other"]).toBeDefined();
    expect(result.mcpServers?.["maestro"]).toEqual({
      type: "http",
      url: "https://orchestra.figmenta.site/mcp/maestro",
      headers: { Authorization: "Bearer orcm_secret" },
    });
  });

  it("does not add the MCP server when the profile grants no tool", () => {
    const result = enforceConfig(base, { ...profile, tools: [] });
    expect(result.mcpServers).toBeUndefined();
  });

  it("enforces nothing when the allow-lists are empty", () => {
    const result = enforceConfig(
      { ...base, model: "whatever", modeId: "acceptEdits" },
      { ...profile, models: [], modes: [], tools: [] },
    );
    expect(result.model).toBe("whatever");
    expect(result.modeId).toBe("acceptEdits");
  });

  it("appends the preamble and the custom instructions to an existing prompt", () => {
    const result = enforceConfig({ ...base, systemPrompt: "Be terse." }, profile);
    expect(result.systemPrompt).toBe(
      `Be terse.\n\n${MAESTRO_BASE}\n\nCall me by my first name.`,
    );
  });

  it("is idempotent: enforcing twice does not duplicate the preamble", () => {
    const once = enforceConfig(base, profile);
    const twice = enforceConfig(once, profile);
    expect(twice.systemPrompt).toBe(once.systemPrompt);
  });
});

describe("composeSystemPrompt", () => {
  it("drops empty parts", () => {
    expect(composeSystemPrompt(undefined, "")).toBe(MAESTRO_BASE);
  });
});
