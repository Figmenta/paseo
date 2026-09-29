/** @vitest-environment jsdom */
/**
 * The `modes` / `efforts` hunk in `composer/draft/input-draft.ts`: a draft (workspace tab after
 * `/clear`, new workspace, setup dialog) reads the person's default ("*"), and its composer state,
 * its `DraftAgentControls` props and the config it would submit all carry the narrowed lists and a
 * selection moved into them. The form state is a fixture shaped like a Claude draft whose saved
 * preferences say Bypass and Max.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));

vi.mock("@/hooks/use-agent-form-state", () => {
  const modeOptions = [
    { id: "plan", label: "Plan Mode" },
    { id: "default", label: "Always Ask" },
    { id: "acceptEdits", label: "Accept File Edits" },
    { id: "auto", label: "Auto mode" },
    { id: "bypassPermissions", label: "Bypass" },
  ];
  const thinkingOptions = [
    { id: "off", label: "Off" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultra Code" },
  ];
  const model = {
    provider: "claude",
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    isDefault: true,
    defaultThinkingOptionId: "high",
    thinkingOptions,
  };
  const noop = () => undefined;
  // One object for every render, as the real hook's memo returns while nothing changes.
  const formState = {
    selectedServerId: "host-1",
    selectedProvider: "claude",
    selectedMode: "bypassPermissions",
    setModeFromUser: noop,
    selectedModel: "claude-sonnet-5",
    setModelFromUser: noop,
    selectedThinkingOptionId: "max",
    setThinkingOptionFromUser: noop,
    workingDir: "/repo",
    providerDefinitions: [{ id: "claude", label: "Claude", modes: modeOptions }],
    providerDefinitionMap: new Map(),
    agentDefinition: undefined,
    modeOptions,
    availableModels: [model],
    allProviderModels: new Map([["claude", [model]]]),
    modelSelectorProviders: [],
    isAllModelsLoading: false,
    isProviderModelsRefreshing: false,
    availableThinkingOptions: thinkingOptions,
    isModelLoading: false,
    modelError: null,
    refreshProviderModels: noop,
    refetchProviderModelsIfStale: noop,
    setProviderAndModelFromUser: noop,
    applyProfileFromUser: noop,
    clearProviderSelectionFromUser: noop,
    workingDirIsEmpty: false,
    persistFormPreferences: async () => undefined,
  };
  return { useAgentFormState: () => formState };
});

const mountedRoots = new Set<Root>();

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.clear();
  });
});

let useAgentInputDraft: typeof import("@/composer/draft/input-draft").useAgentInputDraft;

beforeAll(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  ({ useAgentInputDraft } = await import("@/composer/draft/input-draft"));
  // The composer's module graph is large: the first import alone takes seconds.
}, 120_000);

type Draft = ReturnType<typeof useAgentInputDraft>;

const ids = (options: ReadonlyArray<{ id: string }> | undefined) =>
  (options ?? []).map((option) => option.id);

async function post(data: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  });
}

async function renderDraft(): Promise<() => Draft> {
  let latest: Draft | null = null;
  function Probe() {
    latest = useAgentInputDraft({
      draftKey: "draft:modes-efforts",
      composer: { initialServerId: "host-1", isVisible: true, lockedWorkingDir: "/repo" },
    });
    return null;
  }
  const container = document.getElementById("root");
  if (!container) throw new Error("Missing root container");
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return () => {
    if (!latest) throw new Error("Expected hook result");
    return latest;
  };
}

describe('a draft under the person\'s default (agentId "*") modes and efforts', () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    asyncStorage.clear();
    document.body.innerHTML = "<div id='root'></div>";
    useDraftStore.setState({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
    });
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
  });

  it("without a default the draft keeps its saved Bypass and Max", async () => {
    const latest = await renderDraft();

    const state = latest().composerState!;
    expect(state.selectedMode).toBe("bypassPermissions");
    expect(state.agentControls.modeOptions).toHaveLength(5);
    expect(state.commandDraftConfig).toMatchObject({
      modeId: "bypassPermissions",
      thinkingOptionId: "max",
    });
  });

  it("offers only the allowed modes and efforts and selects Auto and Low, down to the config", async () => {
    const latest = await renderDraft();

    await post({
      type: "maestro.models.allow",
      agentId: "*",
      models: ["claude-sonnet-5"],
      modes: ["auto", "plan"],
      efforts: ["low"],
    });

    const state = latest().composerState!;
    // What the composer's DraftAgentControls receives.
    expect(ids(state.agentControls.modeOptions)).toEqual(["plan", "auto"]);
    expect(state.agentControls.selectedMode).toBe("auto");
    expect(ids(state.agentControls.thinkingOptions)).toEqual(["low"]);
    expect(state.agentControls.selectedThinkingOptionId).toBe("low");
    // What the command center of the draft and the submit read (workspace-tab.tsx).
    expect(ids(state.modeOptions)).toEqual(["plan", "auto"]);
    expect(state.selectedMode).toBe("auto");
    expect(ids(state.availableThinkingOptions)).toEqual(["low"]);
    expect(state.effectiveThinkingOptionId).toBe("low");
    expect(state.commandDraftConfig).toMatchObject({ modeId: "auto", thinkingOptionId: "low" });
  });

  it("an agent's own entry does not reach the draft", async () => {
    const latest = await renderDraft();

    await post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      modes: ["plan"],
      efforts: ["low"],
    });

    expect(latest().composerState!.selectedMode).toBe("bypassPermissions");
    expect(latest().composerState!.effectiveThinkingOptionId).toBe("max");
  });
});
