// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfilePicker } from "@/agent-profiles";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";
import {
  filterProfilesByModelsAllow,
  filterProvidersByModelsAllow,
  useEmbedModelsAllowMenu,
} from "./models-allow";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

function row(provider: string, modelId: string): ProviderSelectionModelRow {
  return {
    favoriteKey: `${provider}:${modelId}`,
    provider,
    providerLabel: provider,
    modelId,
    modelLabel: modelId,
  };
}

function claude(...modelIds: string[]): ProviderSelectorProvider {
  return {
    id: "claude",
    label: "Claude",
    modelSelection: { kind: "models", rows: modelIds.map((id) => row("claude", id)) },
  };
}

function rowIds(providers: ProviderSelectorProvider[]): string[][] {
  return providers.map((provider) =>
    provider.modelSelection.kind === "models"
      ? provider.modelSelection.rows.map((entry) => entry.modelId)
      : [provider.modelSelection.kind],
  );
}

const CLAUDE_ROWS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-sonnet-5[1m]",
  "claude-opus-4-8",
] as const;

function profilePicker(): AgentProfilePicker {
  const base = { provider: "claude", icon: "", color: "", summary: "" };
  return {
    rows: [
      { ...base, id: "p-opus", name: "Deep", modelId: "claude-opus-5" },
      { ...base, id: "p-sonnet", name: "Quick", modelId: "claude-sonnet-5" },
      { ...base, id: "p-plan", name: "Plan only", modelId: "" },
    ],
    applyProfile: vi.fn(),
  };
}

describe("filterProvidersByModelsAllow", () => {
  it("returns the very same list when there is no filter", () => {
    const providers = [claude(...CLAUDE_ROWS)];

    expect(filterProvidersByModelsAllow(providers, null)).toBe(providers);
  });

  it("keeps only the rows whose model id is in the list, in their order", () => {
    const providers = [claude(...CLAUDE_ROWS)];

    const filtered = filterProvidersByModelsAllow(providers, [
      "claude-opus-4-8",
      "claude-sonnet-5",
    ]);

    expect(rowIds(filtered)).toEqual([["claude-sonnet-5", "claude-opus-4-8"]]);
    expect(filtered[0]).toMatchObject({ id: "claude", label: "Claude" });
  });

  it("matches ids exactly: the [1m] variant is its own row", () => {
    const filtered = filterProvidersByModelsAllow([claude(...CLAUDE_ROWS)], ["claude-sonnet-5"]);

    expect(rowIds(filtered)).toEqual([["claude-sonnet-5"]]);
  });

  it("keeps a provider left with no allowed row, with an empty list", () => {
    const filtered = filterProvidersByModelsAllow([claude(...CLAUDE_ROWS)], ["gpt-5"]);

    expect(filtered).toHaveLength(1);
    expect(rowIds(filtered)).toEqual([[]]);
  });

  it("lets loading and error providers through untouched", () => {
    const loading: ProviderSelectorProvider = {
      id: "codex",
      label: "Codex",
      modelSelection: { kind: "loading" },
    };
    const failed: ProviderSelectorProvider = {
      id: "opencode",
      label: "OpenCode",
      modelSelection: { kind: "error", message: "down" },
    };

    const filtered = filterProvidersByModelsAllow(
      [loading, claude(...CLAUDE_ROWS), failed],
      ["claude-sonnet-5"],
    );

    expect(filtered[0]).toBe(loading);
    expect(filtered[2]).toBe(failed);
    expect(rowIds(filtered)).toEqual([["loading"], ["claude-sonnet-5"], ["error"]]);
  });

  it("does not touch the providers it was given", () => {
    const providers = [claude(...CLAUDE_ROWS)];

    filterProvidersByModelsAllow(providers, ["claude-sonnet-5"]);

    expect(rowIds(providers)).toEqual([[...CLAUDE_ROWS]]);
  });
});

describe("filterProfilesByModelsAllow", () => {
  it("returns the very same picker when there is no filter", () => {
    const profiles = profilePicker();

    expect(filterProfilesByModelsAllow(profiles, null)).toBe(profiles);
  });

  it("stays null when the host has no profiles", () => {
    expect(filterProfilesByModelsAllow(null, ["claude-sonnet-5"])).toBeNull();
  });

  it("hides the profiles that would switch to a model outside the list", () => {
    const profiles = profilePicker();

    const filtered = filterProfilesByModelsAllow(profiles, ["claude-sonnet-5"]);

    expect(filtered?.rows.map((entry) => entry.id)).toEqual(["p-sonnet", "p-plan"]);
    expect(filtered?.applyProfile).toBe(profiles.applyProfile);
  });
});

describe("useEmbedModelsAllowMenu", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
  });

  afterEach(() => {
    cleanup();
  });

  function post(data: unknown): void {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
    });
  }

  function renderMenu(agentId: string) {
    const providers = [claude(...CLAUDE_ROWS)];
    const profiles = profilePicker();
    const hook = renderHook(() => useEmbedModelsAllowMenu({ agentId, providers, profiles }));
    return { hook, providers, profiles };
  }

  it("passes the menu through untouched while Orchestra sent no list", () => {
    const { hook, providers, profiles } = renderMenu("a1");

    expect(hook.result.current.providers).toBe(providers);
    expect(hook.result.current.profiles).toBe(profiles);
  });

  it("narrows the menu of the agent named in the message, live", () => {
    const { hook } = renderMenu("a1");

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(rowIds(hook.result.current.providers)).toEqual([["claude-sonnet-5"]]);
    expect(hook.result.current.profiles?.rows.map((entry) => entry.id)).toEqual([
      "p-sonnet",
      "p-plan",
    ]);

    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-opus-5", "claude-sonnet-5"],
    });

    expect(rowIds(hook.result.current.providers)).toEqual([["claude-opus-5", "claude-sonnet-5"]]);
  });

  it("leaves another agent's menu alone", () => {
    const { hook, providers } = renderMenu("a2");

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(hook.result.current.providers).toBe(providers);
  });

  it("is already narrowed when it mounts after the message", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-opus-4-8"] });

    const { hook } = renderMenu("a1");

    expect(rowIds(hook.result.current.providers)).toEqual([["claude-opus-4-8"]]);
  });

  it("keeps the same filtered list across a repeated message", () => {
    const { hook } = renderMenu("a1");
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    const before = hook.result.current.providers;

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(hook.result.current.providers).toBe(before);
  });

  it("does nothing outside the embed", () => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/");
    resetEmbedModeCache();
    const { hook, providers } = renderMenu("a1");

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(hook.result.current.providers).toBe(providers);
  });
});
