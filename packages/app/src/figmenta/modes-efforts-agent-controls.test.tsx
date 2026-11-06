// @vitest-environment jsdom
/**
 * The `modes` / `efforts` hunks in `composer/agent-controls/index.tsx` (`AgentControls`,
 * `ControlledAgentControls`) and `mode-control.tsx`: an existing agent's mode menu, effort menu,
 * command center groups and profile modes list only what Orchestra allows, desktop and compact;
 * its current mode and effort are never changed, and the triggers keep naming them. The surfaces
 * are stand-ins that record what they were given; the store and the snapshot are fixtures.
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";

const seen = vi.hoisted(() => ({
  state: null as unknown,
  currentModeId: "auto",
  modeControl: null as null | {
    modeOptions: Array<{ id: string }>;
    selectedModeId: string | null | undefined;
    selectedModeFallback?: { id: string } | null;
  },
  thinkingCombobox: null as null | Array<{ id: string }>,
  commandCenter: null as null | {
    thinking: { options: Array<{ id: string }> | null | undefined };
    modes?: { options: Array<{ id: string }> };
  },
  profileTarget: null as null | { availableModeIds: readonly string[] | null },
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: () => null,
}));

// The compact sheet renders its children: effort and mode live inside it on that form factor.
vi.mock("@/composer/agent-controls/model-sheet", async () => {
  const { createElement } = await import("react");
  return {
    CompactModelSheet: (props: { children?: unknown; thinkingLabel?: string | null }) =>
      createElement(
        "div",
        { "data-testid": "stand-in-compact-model-sheet", "data-thinking": props.thinkingLabel },
        props.children as never,
      ),
  };
});

// No provider list and a stand-in mode control: the only combobox left is the effort menu.
vi.mock("@/components/ui/combobox", () => ({
  Combobox: (props: { options: Array<{ id: string }> }) => {
    seen.thinkingCombobox = props.options;
    return null;
  },
  ComboboxItem: () => null,
}));

vi.mock("@/command-center/agent-control-registration", () => ({
  useAgentControlCommandCenterActions: (input: { controls: typeof seen.commandCenter }) => {
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
  // Sonnet 5, as the manifest builds it.
  const thinkingOptions: AgentSelectOption[] = [
    { id: "off", label: "Off" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultra Code" },
  ];
  const models: AgentModelDefinition[] = [
    {
      provider: "claude",
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      isDefault: true,
      thinkingOptions,
      defaultThinkingOptionId: "high",
    },
  ];
  const modes: AgentMode[] = [
    { id: "plan", label: "Plan Mode" },
    { id: "default", label: "Always Ask" },
    { id: "acceptEdits", label: "Accept File Edits" },
    { id: "auto", label: "Auto mode" },
    { id: "bypassPermissions", label: "Bypass" },
  ];
  const entries: ProviderSnapshotEntry[] = [
    { provider: "claude", status: "ready", enabled: true, label: "Claude", models, modes },
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
  const { createElement, useMemo } = await import("react");
  const modes = [
    { id: "plan", label: "Plan Mode" },
    { id: "default", label: "Always Ask" },
    { id: "acceptEdits", label: "Accept File Edits" },
    { id: "auto", label: "Auto mode" },
    { id: "bypassPermissions", label: "Bypass" },
  ];
  function noop(): void {}
  return {
    AgentModeControl: (props: NonNullable<typeof seen.modeControl>) => {
      seen.modeControl = props;
      return createElement("div", { "data-testid": "stand-in-mode-control" });
    },
    useLiveAgentModeControl: () => {
      const currentModeId = seen.currentModeId;
      return useMemo(
        () => ({
          provider: "claude",
          providerDefinitions: [],
          modeOptions: modes,
          selectedModeId: currentModeId,
          onSelectMode: noop,
        }),
        [currentModeId],
      );
    },
  };
});

vi.mock("@/agent-profiles", () => ({
  AgentProfileGlyph: () => null,
  useAgentProfilePicker: (input: { target: { availableModeIds: readonly string[] | null } }) => {
    seen.profileTarget = input.target;
    return null;
  },
  useAgentProfileEditor: () => ({
    element: null,
    openCreateFromModel: () => {},
    openEdit: () => {},
  }),
}));

import { AgentControls } from "@/composer/agent-controls";

beforeEach(() => vi.stubGlobal("React", React));

const ALL_MODES = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"];
const ALL_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max", "ultracode"];

function post(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  });
}

function allow(agentId: string, extra: Record<string, unknown>): void {
  post({ type: "maestro.models.allow", agentId, models: ["claude-sonnet-5"], ...extra });
}

const ids = (options: ReadonlyArray<{ id: string }> | null | undefined) =>
  (options ?? []).map((option) => option.id);

function renderControls(isCompactLayout: boolean) {
  return render(<AgentControls agentId="a1" serverId="s1" isCompactLayout={isCompactLayout} />);
}

describe("AgentControls under maestro.models.allow modes and efforts", () => {
  function seedAgent(input: { modeId: string; thinkingOptionId: string }): void {
    seen.currentModeId = input.modeId;
    seen.state = {
      sessions: {
        s1: {
          agents: new Map([
            [
              "a1",
              {
                provider: "claude",
                cwd: "/tmp",
                runtimeInfo: { model: "claude-sonnet-5" },
                model: "claude-sonnet-5",
                features: [],
                thinkingOptionId: input.thinkingOptionId,
                lastUsage: null,
              },
            ],
          ]),
          client: {},
        },
      },
    };
  }

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    seen.modeControl = null;
    seen.thinkingCombobox = null;
    seen.commandCenter = null;
    seen.profileTarget = null;
    seedAgent({ modeId: "auto", thinkingOptionId: "low" });
  });

  afterEach(() => {
    cleanup();
  });

  it("offers every mode and effort while Orchestra sent none", () => {
    renderControls(false);

    allow("a1", {});

    expect(ids(seen.modeControl?.modeOptions)).toEqual(ALL_MODES);
    expect(ids(seen.thinkingCombobox)).toEqual(ALL_EFFORTS);
    expect(ids(seen.commandCenter?.modes?.options)).toEqual(ALL_MODES);
    expect(ids(seen.commandCenter?.thinking.options)).toEqual(ALL_EFFORTS);
    expect(seen.profileTarget?.availableModeIds).toEqual(ALL_MODES);
  });

  it("desktop: the mode menu, the effort menu, the command center and the profiles narrow", () => {
    renderControls(false);

    allow("a1", { modes: ["auto", "plan"], efforts: ["low"] });

    expect(ids(seen.modeControl?.modeOptions)).toEqual(["plan", "auto"]);
    expect(ids(seen.thinkingCombobox)).toEqual(["low"]);
    expect(ids(seen.commandCenter?.modes?.options)).toEqual(["plan", "auto"]);
    expect(ids(seen.commandCenter?.thinking.options)).toEqual(["low"]);
    expect(seen.profileTarget?.availableModeIds).toEqual(["plan", "auto"]);
  });

  it("compact: the sheet's effort menu and mode control narrow the same way", () => {
    renderControls(true);

    allow("a1", { modes: ["auto", "plan"], efforts: ["low"] });

    expect(screen.queryByTestId("stand-in-compact-model-sheet")).not.toBeNull();
    expect(screen.queryByTestId("agent-controls-thinking")).not.toBeNull();
    expect(ids(seen.modeControl?.modeOptions)).toEqual(["plan", "auto"]);
    expect(ids(seen.thinkingCombobox)).toEqual(["low"]);
  });

  it("the person's default reaches an agent Orchestra never named; its own entry wins whole", () => {
    renderControls(false);

    allow("*", { modes: ["plan"], efforts: ["high"] });
    expect(ids(seen.modeControl?.modeOptions)).toEqual(["plan"]);
    expect(ids(seen.thinkingCombobox)).toEqual(["high"]);

    allow("a1", {});
    expect(ids(seen.modeControl?.modeOptions)).toEqual(ALL_MODES);
    expect(ids(seen.thinkingCombobox)).toEqual(ALL_EFFORTS);
  });

  it("never moves an existing agent: a current mode and effort outside the list stay named", () => {
    seedAgent({ modeId: "bypassPermissions", thinkingOptionId: "max" });
    renderControls(false);

    allow("a1", { modes: ["auto", "plan"], efforts: ["low"] });

    expect(ids(seen.modeControl?.modeOptions)).toEqual(["plan", "auto"]);
    expect(seen.modeControl?.selectedModeId).toBe("bypassPermissions");
    expect(seen.modeControl?.selectedModeFallback?.id).toBe("bypassPermissions");
    expect(ids(seen.thinkingCombobox)).toEqual(["low"]);
    // The effort trigger names "Max", not the first allowed option.
    const trigger = screen.getByTestId("agent-thinking-selector");
    expect(trigger.textContent).toContain("Max");
    expect(trigger.textContent).not.toContain("Low");
  });

  it("nothing allowed: no mode control, no effort trigger, no command center rows", () => {
    renderControls(false);

    allow("a1", { modes: [], efforts: [] });

    expect(screen.queryByTestId("stand-in-mode-control")).toBeNull();
    expect(screen.queryByTestId("agent-thinking-selector")).toBeNull();
    expect(seen.commandCenter?.modes).toBeUndefined();
    expect(ids(seen.commandCenter?.thinking.options)).toEqual([]);
  });
});
