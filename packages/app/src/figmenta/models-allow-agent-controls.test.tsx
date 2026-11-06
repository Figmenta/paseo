// @vitest-environment jsdom
/**
 * The `maestro.models.allow` hunks in `composer/agent-controls/index.tsx` (`AgentControls` and
 * `DraftAgentControls`): the list reaches every surface that picks a model for that agent, and
 * the person's default (agentId "*") every draft and every agent Orchestra never named. The
 * surfaces themselves are stand-ins that record what they were given; the store, the snapshot
 * and the profiles are fixtures.
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfilePicker } from "@/agent-profiles";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";

const seen = vi.hoisted(() => ({
  desktop: null as null | { providers: unknown; profiles: unknown },
  compact: null as null | { providers: unknown; profiles: unknown },
  commandCenter: null as null | { models: { providers: unknown } },
  profiles: null as unknown,
  state: null as unknown,
}));

// The stand-ins leave a marker in the DOM, so a test can tell "not rendered" from "rendered empty".
vi.mock("@/components/combined-model-selector", async () => {
  const { createElement } = await import("react");
  return {
    CombinedModelSelector: (props: { providers: unknown; profiles: unknown }) => {
      seen.desktop = { providers: props.providers, profiles: props.profiles };
      return createElement("div", { "data-testid": "stand-in-desktop-model-selector" });
    },
  };
});

vi.mock("@/composer/agent-controls/model-sheet", async () => {
  const { createElement } = await import("react");
  return {
    CompactModelSheet: (props: { providers: unknown; profiles: unknown }) => {
      seen.compact = { providers: props.providers, profiles: props.profiles };
      return createElement("div", { "data-testid": "stand-in-compact-model-sheet" });
    },
  };
});

// The real combobox does not load in the unit project («SyntaxError: Unexpected token 'typeof'»).
vi.mock("@/components/ui/combobox", () => ({
  Combobox: () => null,
  ComboboxItem: () => null,
}));

vi.mock("@/command-center/agent-control-registration", () => ({
  useAgentControlCommandCenterActions: (input: {
    controls: { models: { providers: unknown } };
  }) => {
    seen.commandCenter = input.controls;
  },
}));

vi.mock("@/composer/keyboard-scope", () => ({
  useComposerKeyboardScope: () => ({ isActiveComposer: true }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(seen.state),
}));

vi.mock("@/hooks/use-providers-snapshot", () => {
  const thinkingOptions = [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ];
  const models: AgentModelDefinition[] = [
    { provider: "claude", id: "claude-opus-5", label: "Opus 5", thinkingOptions },
    {
      provider: "claude",
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      isDefault: true,
      thinkingOptions,
    },
    { provider: "claude", id: "claude-sonnet-5[1m]", label: "Sonnet 5 1M", thinkingOptions },
  ];
  const entries: ProviderSnapshotEntry[] = [
    { provider: "claude", status: "ready", enabled: true, label: "Claude", models, modes: [] },
  ];
  const result = {
    entries,
    isLoading: false,
    isRefreshing: false,
    refresh: () => Promise.resolve(),
    refetchIfStale: () => {},
  };
  return { useProvidersSnapshot: () => result };
});

vi.mock("@/hooks/use-form-preferences", () => ({
  useFormPreferences: () => ({ updatePreferences: () => Promise.resolve() }),
  mergeProviderPreferences: () => ({}),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: () => {}, show: () => {} }),
}));

vi.mock("@/composer/agent-controls/mode-control", async () => {
  const { createElement } = await import("react");
  const modeControl = {
    provider: "claude",
    providerDefinitions: [],
    modeOptions: [{ id: "default", label: "Default" }],
    selectedModeId: "default",
    onSelectMode: () => {},
  };
  return {
    AgentModeControl: () => createElement("div", { "data-testid": "stand-in-mode-control" }),
    useLiveAgentModeControl: () => modeControl,
  };
});

vi.mock("@/agent-profiles", () => ({
  AgentProfileGlyph: () => null,
  useAgentProfilePicker: () => seen.profiles,
  useAgentProfileEditor: () => ({
    element: null,
    openCreateFromModel: () => {},
    openEdit: () => {},
  }),
}));

import { AgentControls, DraftAgentControls } from "@/composer/agent-controls";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const PROFILES: AgentProfilePicker = {
  rows: [
    {
      id: "p-opus",
      provider: "claude",
      modelId: "claude-opus-5",
      icon: "",
      color: "",
      name: "Deep",
      summary: "",
    },
    {
      id: "p-plan",
      provider: "claude",
      modelId: "",
      icon: "",
      color: "",
      name: "Plan",
      summary: "",
    },
  ],
  applyProfile: () => {},
};

function rowIds(providers: unknown): string[] {
  return (providers as ProviderSelectorProvider[]).flatMap((provider) =>
    provider.modelSelection.kind === "models"
      ? provider.modelSelection.rows.map((entry) => entry.modelId)
      : [],
  );
}

function profileIds(profiles: unknown): string[] {
  return (profiles as AgentProfilePicker).rows.map((entry) => entry.id);
}

function noop(): void {}

function post(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  });
}

function renderControls(isCompactLayout: boolean) {
  return render(<AgentControls agentId="a1" serverId="s1" isCompactLayout={isCompactLayout} />);
}

const ALL = ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-5[1m]"];

describe("AgentControls under maestro.models.allow", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    seen.desktop = null;
    seen.compact = null;
    seen.commandCenter = null;
    seen.profiles = PROFILES;
    const agent = {
      provider: "claude",
      cwd: "/tmp",
      runtimeInfo: { model: "claude-opus-5" },
      model: "claude-opus-5",
      features: [],
      thinkingOptionId: null,
      lastUsage: null,
    };
    seen.state = {
      sessions: { s1: { agents: new Map([["a1", agent]]), client: {} } },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows every model and profile while Orchestra sent no list", () => {
    renderControls(false);

    expect(rowIds(seen.desktop?.providers)).toEqual(ALL);
    expect(profileIds(seen.desktop?.profiles)).toEqual(["p-opus", "p-plan"]);
    expect(rowIds(seen.commandCenter?.models.providers)).toEqual(ALL);
  });

  it("narrows the desktop menu, its profiles and the command center to the list", () => {
    renderControls(false);

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(rowIds(seen.desktop?.providers)).toEqual(["claude-sonnet-5"]);
    expect(profileIds(seen.desktop?.profiles)).toEqual(["p-plan"]);
    expect(rowIds(seen.commandCenter?.models.providers)).toEqual(["claude-sonnet-5"]);
  });

  it("narrows the compact model sheet the same way", () => {
    renderControls(true);

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(seen.desktop).toBeNull();
    expect(rowIds(seen.compact?.providers)).toEqual(["claude-sonnet-5"]);
    expect(profileIds(seen.compact?.profiles)).toEqual(["p-plan"]);
  });

  it("ignores a list for another agent", () => {
    renderControls(false);

    post({ type: "maestro.models.allow", agentId: "a2", models: ["claude-sonnet-5"] });

    expect(rowIds(seen.desktop?.providers)).toEqual(ALL);
    expect(rowIds(seen.commandCenter?.models.providers)).toEqual(ALL);
  });
});

describe("AgentControls under maestro.models.allow hidden", () => {
  const DESKTOP = "stand-in-desktop-model-selector";
  const COMPACT = "stand-in-compact-model-sheet";

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    seen.desktop = null;
    seen.compact = null;
    seen.commandCenter = null;
    seen.profiles = PROFILES;
    seen.state = {
      sessions: {
        s1: {
          agents: new Map([
            [
              "a1",
              {
                provider: "claude",
                cwd: "/tmp",
                runtimeInfo: { model: "claude-opus-5" },
                model: "claude-opus-5",
                features: [],
                thinkingOptionId: "high",
                lastUsage: null,
              },
            ],
          ]),
          client: {},
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  function hide(hidden: boolean, agentId = "a1"): void {
    post({ type: "maestro.models.allow", agentId, models: ["claude-sonnet-5"], hidden });
  }

  it("desktop: no model selector, effort and permission mode stay", () => {
    renderControls(false);
    expect(screen.queryByTestId(DESKTOP)).not.toBeNull();

    hide(true);

    expect(screen.queryByTestId(DESKTOP)).toBeNull();
    expect(screen.queryByTestId("agent-thinking-selector")).not.toBeNull();
    expect(screen.queryByTestId("stand-in-mode-control")).not.toBeNull();
  });

  it("compact: no model sheet (its trigger carries the model name), effort and mode stay", () => {
    renderControls(true);
    expect(screen.queryByTestId(COMPACT)).not.toBeNull();

    hide(true);

    expect(screen.queryByTestId(COMPACT)).toBeNull();
    expect(screen.queryByTestId(DESKTOP)).toBeNull();
    expect(screen.queryByTestId("agent-thinking-selector")).not.toBeNull();
    expect(screen.queryByTestId("stand-in-mode-control")).not.toBeNull();
  });

  it("command center: no model group while hidden, the thinking and mode groups stay", () => {
    renderControls(false);

    hide(true);

    expect(rowIds(seen.commandCenter?.models.providers)).toEqual([]);
    const controls = seen.commandCenter as unknown as {
      thinking: { options: Array<{ id: string }> };
      modes?: { options: Array<{ id: string }> };
    };
    expect(controls.thinking.options.map((option) => option.id)).toEqual(["low", "high"]);
    expect(controls.modes?.options.map((option) => option.id)).toEqual(["default"]);
  });

  it("hidden:false shows the selector again, narrowed by the list", () => {
    renderControls(false);
    hide(true);
    expect(screen.queryByTestId(DESKTOP)).toBeNull();

    hide(false);

    expect(screen.queryByTestId(DESKTOP)).not.toBeNull();
    expect(rowIds(seen.desktop?.providers)).toEqual(["claude-sonnet-5"]);
    expect(profileIds(seen.desktop?.profiles)).toEqual(["p-plan"]);
    expect(rowIds(seen.commandCenter?.models.providers)).toEqual(["claude-sonnet-5"]);
  });

  it("compact, shown again: the model sheet comes back", () => {
    renderControls(true);
    hide(true);
    expect(screen.queryByTestId(COMPACT)).toBeNull();

    hide(false);

    expect(screen.queryByTestId(COMPACT)).not.toBeNull();
    expect(rowIds(seen.compact?.providers)).toEqual(["claude-sonnet-5"]);
  });

  it("hidden for another agent leaves this one's selector alone", () => {
    renderControls(false);

    hide(true, "a2");

    expect(screen.queryByTestId(DESKTOP)).not.toBeNull();
    expect(rowIds(seen.desktop?.providers)).toEqual(ALL);
  });
});

describe('AgentControls under the person\'s default (agentId "*")', () => {
  const DESKTOP = "stand-in-desktop-model-selector";

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    seen.desktop = null;
    seen.compact = null;
    seen.commandCenter = null;
    seen.profiles = PROFILES;
    // The agent /clear or a fork just created: Orchestra has never named it.
    const agent = {
      provider: "claude",
      cwd: "/tmp",
      runtimeInfo: { model: "claude-sonnet-5" },
      model: "claude-sonnet-5",
      features: [],
      thinkingOptionId: "high",
      lastUsage: null,
    };
    seen.state = {
      sessions: { s1: { agents: new Map([["a1", agent]]), client: {} } },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("an agent Orchestra never named takes a hidden default: no selector, no model group", () => {
    renderControls(false);

    post({ type: "maestro.models.allow", agentId: "*", models: [], hidden: true });

    expect(screen.queryByTestId(DESKTOP)).toBeNull();
    expect(screen.queryByTestId("agent-thinking-selector")).not.toBeNull();
    expect(rowIds(seen.commandCenter?.models.providers)).toEqual([]);
  });

  it("an agent Orchestra never named is narrowed by a shown default", () => {
    renderControls(false);

    post({ type: "maestro.models.allow", agentId: "*", models: ["claude-sonnet-5"] });

    expect(rowIds(seen.desktop?.providers)).toEqual(["claude-sonnet-5"]);
    expect(rowIds(seen.commandCenter?.models.providers)).toEqual(["claude-sonnet-5"]);
  });

  it("the agent's own entry beats the default", () => {
    renderControls(false);
    post({ type: "maestro.models.allow", agentId: "*", models: [], hidden: true });
    expect(screen.queryByTestId(DESKTOP)).toBeNull();

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-opus-5"] });

    expect(screen.queryByTestId(DESKTOP)).not.toBeNull();
    expect(rowIds(seen.desktop?.providers)).toEqual(["claude-opus-5"]);
  });
});

describe('DraftAgentControls under the person\'s default (agentId "*")', () => {
  const DESKTOP = "stand-in-desktop-model-selector";
  const COMPACT = "stand-in-compact-model-sheet";
  const THINKING = [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ];

  function claudeProviders(): ProviderSelectorProvider[] {
    return [
      {
        id: "claude",
        label: "Claude",
        modelSelection: {
          kind: "models",
          rows: ALL.map((modelId) => ({
            favoriteKey: `claude:${modelId}`,
            provider: "claude",
            providerLabel: "Claude",
            modelId,
            modelLabel: modelId,
          })),
        },
      },
    ];
  }

  function renderDraft(isCompactLayout: boolean) {
    return render(
      <DraftAgentControls
        providerDefinitions={[]}
        selectedProvider="claude"
        modeOptions={[{ id: "default", label: "Default" }]}
        selectedMode="default"
        onSelectMode={noop}
        models={[]}
        selectedModel="claude-sonnet-5"
        onSelectModel={noop}
        isModelLoading={false}
        modelSelectorProviders={claudeProviders()}
        isAllModelsLoading={false}
        onSelectProviderAndModel={noop}
        thinkingOptions={THINKING}
        selectedThinkingOptionId="high"
        onSelectThinkingOption={noop}
        onApplyAgentProfile={noop}
        modelSelectorServerId="s1"
        isCompactLayout={isCompactLayout}
      />,
    );
  }

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    seen.desktop = null;
    seen.compact = null;
    seen.profiles = PROFILES;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows every model and profile while there is no default", () => {
    renderDraft(false);

    // An agent's own word does not reach a draft: it has no agentId.
    post({ type: "maestro.models.allow", agentId: "a1", models: [], hidden: true });

    expect(screen.queryByTestId(DESKTOP)).not.toBeNull();
    expect(rowIds(seen.desktop?.providers)).toEqual(ALL);
    expect(profileIds(seen.desktop?.profiles)).toEqual(["p-opus", "p-plan"]);
  });

  it("desktop: a hidden default removes the model selector, effort and mode stay", () => {
    renderDraft(false);

    post({ type: "maestro.models.allow", agentId: "*", models: [], hidden: true });

    expect(screen.queryByTestId(DESKTOP)).toBeNull();
    expect(screen.queryByTestId("agent-thinking-selector")).not.toBeNull();
    expect(screen.queryByTestId("stand-in-mode-control")).not.toBeNull();
  });

  it("compact: a hidden default removes the model sheet, the toolbar keeps effort and mode", () => {
    renderDraft(true);
    expect(screen.queryByTestId(COMPACT)).not.toBeNull();

    post({ type: "maestro.models.allow", agentId: "*", models: [], hidden: true });

    expect(screen.queryByTestId(COMPACT)).toBeNull();
    expect(screen.queryByTestId(DESKTOP)).toBeNull();
    expect(screen.queryByTestId("agent-thinking-selector")).not.toBeNull();
    expect(screen.queryByTestId("stand-in-mode-control")).not.toBeNull();
  });

  it("a shown default narrows the draft menu and its profiles, desktop and compact", () => {
    renderDraft(false);
    post({ type: "maestro.models.allow", agentId: "*", models: [], hidden: true });

    post({ type: "maestro.models.allow", agentId: "*", models: ["claude-sonnet-5"] });

    expect(screen.queryByTestId(DESKTOP)).not.toBeNull();
    expect(rowIds(seen.desktop?.providers)).toEqual(["claude-sonnet-5"]);
    expect(profileIds(seen.desktop?.profiles)).toEqual(["p-plan"]);

    cleanup();
    renderDraft(true);
    expect(rowIds(seen.compact?.providers)).toEqual(["claude-sonnet-5"]);
    expect(profileIds(seen.compact?.profiles)).toEqual(["p-plan"]);
  });
});
