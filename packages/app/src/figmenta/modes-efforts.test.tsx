// @vitest-environment jsdom
/**
 * `figmenta/modes-efforts.ts`: the pure rules (filter, the new-session choice of mode and effort,
 * the existing agent's narrowed control) and the two hooks that read the person's default ("*"):
 * the draft's form state and the schedule form's fields. The ids and the order are the real ones
 * of the Claude provider (agent.ts DEFAULT_MODES, model-manifest.ts buildThinkingOptions).
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMode, AgentSelectOption } from "@getpaseo/protocol/agent-types";
import type { AgentModeControlValue } from "@/composer/agent-controls/mode-control";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";
import {
  filterAllowedOptions,
  narrowDraftForm,
  narrowEffortOptions,
  narrowModeControl,
  narrowModeIds,
  resolveAllowedEffortId,
  resolveAllowedModeId,
  useEmbedDraftModesEfforts,
  useEmbedScheduleModesEfforts,
  type EmbedDraftModesEffortsForm,
} from "./modes-efforts";

beforeEach(() => vi.stubGlobal("React", React));

/** Claude's permission modes, in the provider's order. */
const CLAUDE_MODES: AgentMode[] = [
  { id: "plan", label: "Plan Mode" },
  { id: "default", label: "Always Ask" },
  { id: "acceptEdits", label: "Accept File Edits" },
  { id: "auto", label: "Auto mode" },
  { id: "bypassPermissions", label: "Bypass" },
];

/** Sonnet 5's effort options, in the manifest's order (default "high"). */
const SONNET_5_EFFORTS: AgentSelectOption[] = [
  { id: "off", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", isDefault: true },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultracode", label: "Ultra Code" },
];

const ids = (options: ReadonlyArray<{ id: string }> | null) =>
  options === null ? null : options.map((option) => option.id);

function post(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  });
}

function postDefault(extra: Record<string, unknown>): void {
  post({ type: "maestro.models.allow", agentId: "*", models: ["claude-sonnet-5"], ...extra });
}

function resetEmbed(): void {
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/agents-ui/?embed=1");
  resetEmbedModeCache();
  installEmbedBridge();
}

describe("filterAllowedOptions", () => {
  it("keeps the allowed ids in the provider's order, whatever order Orchestra sent", () => {
    expect(ids(filterAllowedOptions(CLAUDE_MODES, ["plan", "auto"]))).toEqual(["plan", "auto"]);
    expect(ids(filterAllowedOptions(CLAUDE_MODES, ["auto", "plan"]))).toEqual(["plan", "auto"]);
  });

  it("no filter = the same array; an empty filter = nothing", () => {
    expect(filterAllowedOptions(CLAUDE_MODES, undefined)).toBe(CLAUDE_MODES);
    expect(filterAllowedOptions(CLAUDE_MODES, [])).toEqual([]);
  });

  it("ignores ids the provider does not have", () => {
    expect(ids(filterAllowedOptions(SONNET_5_EFFORTS, ["low", "turbo"]))).toEqual(["low"]);
  });
});

describe("resolveAllowedModeId (a new session's mode)", () => {
  const resolve = (selectedId: string, allowed: string[] | undefined, options = CLAUDE_MODES) =>
    resolveAllowedModeId({ options, selectedId, allowed });

  it("keeps an allowed selection", () => {
    expect(resolve("plan", ["auto", "plan"])).toBe("plan");
  });

  it('moves a selection outside the list to "auto" when allowed', () => {
    expect(resolve("bypassPermissions", ["plan", "auto"])).toBe("auto");
    expect(resolve("", ["plan", "auto"])).toBe("auto");
  });

  it("else to the first allowed in the provider's order", () => {
    expect(resolve("bypassPermissions", ["acceptEdits", "plan"])).toBe("plan");
  });

  it('nothing allowed = "" (the daemon picks)', () => {
    expect(resolve("auto", [])).toBe("");
    expect(resolve("auto", ["not-a-claude-mode"])).toBe("");
  });

  it("no filter, or no options yet, leaves the selection alone", () => {
    expect(resolve("bypassPermissions", undefined)).toBe("bypassPermissions");
    expect(resolve("bypassPermissions", ["auto"], [])).toBe("bypassPermissions");
  });
});

describe("resolveAllowedEffortId (a new session's effort)", () => {
  const resolve = (selectedId: string, allowed: string[] | undefined, options = SONNET_5_EFFORTS) =>
    resolveAllowedEffortId({ options, selectedId, allowed });

  it("keeps an allowed selection", () => {
    expect(resolve("medium", ["low", "medium", "high"])).toBe("medium");
  });

  it("moves a selection outside the list to the highest allowed, in the manifest's order", () => {
    expect(resolve("max", ["low"])).toBe("low");
    expect(resolve("max", ["medium", "low"])).toBe("medium");
    expect(resolve("off", ["high", "low", "medium"])).toBe("high");
  });

  it("no selection = the model's default: kept when allowed, moved when not", () => {
    expect(resolve("", ["low", "high"])).toBe("");
    expect(resolve("", ["low", "medium"])).toBe("medium");
  });

  it('nothing allowed = "" (the daemon picks)', () => {
    expect(resolve("high", [])).toBe("");
  });

  it("no filter, or a model without efforts, leaves the selection alone", () => {
    expect(resolve("max", undefined)).toBe("max");
    expect(resolve("max", ["low"], [])).toBe("max");
  });
});

describe("narrowModeControl (an existing agent: filter only)", () => {
  const control: AgentModeControlValue = {
    provider: "claude",
    providerDefinitions: [],
    modeOptions: CLAUDE_MODES,
    selectedModeId: "auto",
    onSelectMode: () => {},
  };

  it("lists only the allowed modes, the current one listed", () => {
    const narrowed = narrowModeControl(control, ["auto", "plan"]);
    expect(ids(narrowed!.modeOptions)).toEqual(["plan", "auto"]);
    expect(narrowed!.selectedModeId).toBe("auto");
    expect(narrowed!.selectedModeFallback).toBeNull();
  });

  it("never changes the current mode: outside the list, the trigger still names it", () => {
    const narrowed = narrowModeControl({ ...control, selectedModeId: "bypassPermissions" }, [
      "auto",
      "plan",
    ]);
    expect(ids(narrowed!.modeOptions)).toEqual(["plan", "auto"]);
    expect(narrowed!.selectedModeId).toBe("bypassPermissions");
    expect(narrowed!.selectedModeFallback?.id).toBe("bypassPermissions");
  });

  it("nothing allowed = no mode control; no filter = the same control", () => {
    expect(narrowModeControl(control, [])).toBeNull();
    expect(narrowModeControl(control, undefined)).toBe(control);
    expect(narrowModeControl(null, ["auto"])).toBeNull();
  });
});

describe("narrowEffortOptions (an existing agent: filter only)", () => {
  it("lists only the allowed efforts", () => {
    const narrowed = narrowEffortOptions(SONNET_5_EFFORTS, "low", ["low", "high"]);
    expect(ids(narrowed.options)).toEqual(["low", "high"]);
    expect(narrowed.selectedLabel).toBeUndefined();
  });

  it("names the current effort when the list leaves it out", () => {
    const narrowed = narrowEffortOptions(SONNET_5_EFFORTS, "max", ["low"]);
    expect(ids(narrowed.options)).toEqual(["low"]);
    expect(narrowed.selectedLabel).toBe("Max");
  });

  it("no filter, or no options, passes through", () => {
    expect(narrowEffortOptions(SONNET_5_EFFORTS, "max", undefined).options).toBe(SONNET_5_EFFORTS);
    expect(narrowEffortOptions(null, "max", ["low"]).options).toBeNull();
  });
});

describe("narrowModeIds (the modes a profile may apply)", () => {
  it("drops the modes outside the list, passes through without one", () => {
    const all = CLAUDE_MODES.map((mode) => mode.id);
    expect(narrowModeIds(all, ["auto", "plan"])).toEqual(["plan", "auto"]);
    expect(narrowModeIds(all, undefined)).toBe(all);
    expect(narrowModeIds(null, ["auto"])).toBeNull();
  });
});

function draftForm(overrides: Partial<EmbedDraftModesEffortsForm> = {}) {
  return {
    selectedProvider: "claude",
    modeOptions: CLAUDE_MODES,
    selectedMode: "bypassPermissions",
    availableThinkingOptions: SONNET_5_EFFORTS,
    selectedThinkingOptionId: "max",
    ...overrides,
  };
}

describe("narrowDraftForm (a draft: filter and move the selection)", () => {
  it("no modes and no efforts = the very same object", () => {
    const form = draftForm();
    expect(narrowDraftForm(form, undefined, undefined)).toBe(form);
  });

  it("narrows both lists and moves both selections into them, the rest untouched", () => {
    const narrowed = narrowDraftForm(draftForm(), ["auto", "plan"], ["low"]);

    expect(ids(narrowed.modeOptions)).toEqual(["plan", "auto"]);
    expect(narrowed.selectedMode).toBe("auto");
    expect(ids(narrowed.availableThinkingOptions)).toEqual(["low"]);
    expect(narrowed.selectedThinkingOptionId).toBe("low");
    expect(narrowed.selectedProvider).toBe("claude");
  });

  it("only modes: the efforts are left alone, and the other way round", () => {
    const onlyModes = narrowDraftForm(draftForm(), ["plan"], undefined);
    expect(onlyModes.selectedMode).toBe("plan");
    expect(onlyModes.availableThinkingOptions).toBe(SONNET_5_EFFORTS);
    expect(onlyModes.selectedThinkingOptionId).toBe("max");

    const onlyEfforts = narrowDraftForm(draftForm(), undefined, ["medium", "high"]);
    expect(onlyEfforts.modeOptions).toBe(CLAUDE_MODES);
    expect(onlyEfforts.selectedMode).toBe("bypassPermissions");
    expect(onlyEfforts.selectedThinkingOptionId).toBe("high");
  });
});

describe('useEmbedDraftModesEfforts (the person\'s default, "*")', () => {
  const seen = { form: null as null | ReturnType<typeof draftForm> };

  function Probe({ form }: { form: ReturnType<typeof draftForm> }) {
    seen.form = useEmbedDraftModesEfforts(form);
    return null;
  }

  beforeEach(() => {
    resetEmbed();
    seen.form = null;
  });

  afterEach(() => cleanup());

  it("passes the form through until a default with modes or efforts arrives, then narrows it", () => {
    const form = draftForm();
    render(<Probe form={form} />);
    expect(seen.form).toBe(form);

    // An agent's own word does not reach a draft: it has no agentId.
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      modes: ["plan"],
      efforts: ["max"],
    });
    expect(seen.form).toBe(form);

    postDefault({ modes: ["auto", "plan"], efforts: ["low"] });
    expect(ids(seen.form!.modeOptions)).toEqual(["plan", "auto"]);
    expect(seen.form!.selectedMode).toBe("auto");
    expect(ids(seen.form!.availableThinkingOptions)).toEqual(["low"]);
    expect(seen.form!.selectedThinkingOptionId).toBe("low");

    // A default without them lifts the filters.
    postDefault({});
    expect(seen.form).toBe(form);
  });

  it("is inert outside the embed", () => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/");
    resetEmbedModeCache();
    const form = draftForm();
    render(<Probe form={form} />);

    postDefault({ modes: ["auto"], efforts: ["low"] });

    expect(seen.form).toBe(form);
  });
});

describe("useEmbedScheduleModesEfforts (the schedule form's Mode and Thinking)", () => {
  const seen = {
    result: null as null | { modeOptions: AgentMode[]; thinkingOptions: AgentSelectOption[] },
    modeCalls: [] as string[],
    thinkingCalls: [] as string[],
  };

  function Probe({
    selectedMode,
    selectedThinking,
  }: {
    selectedMode: string;
    selectedThinking: string;
  }) {
    seen.result = useEmbedScheduleModesEfforts({
      modeOptions: CLAUDE_MODES,
      selectedMode,
      onSelectMode: recordMode,
      thinkingOptions: SONNET_5_EFFORTS,
      selectedThinkingOptionId: selectedThinking,
      onSelectThinking: recordThinking,
    });
    return null;
  }

  function recordMode(modeId: string): void {
    seen.modeCalls.push(modeId);
  }

  function recordThinking(thinkingOptionId: string): void {
    seen.thinkingCalls.push(thinkingOptionId);
  }

  beforeEach(() => {
    resetEmbed();
    seen.result = null;
    seen.modeCalls = [];
    seen.thinkingCalls = [];
  });

  afterEach(() => cleanup());

  it("offers everything and moves nothing without a default", () => {
    render(<Probe selectedMode="bypassPermissions" selectedThinking="max" />);

    expect(seen.result!.modeOptions).toBe(CLAUDE_MODES);
    expect(seen.result!.thinkingOptions).toBe(SONNET_5_EFFORTS);
    expect(seen.modeCalls).toEqual([]);
    expect(seen.thinkingCalls).toEqual([]);
  });

  it("narrows both fields and moves the form's selection into them through its setters", () => {
    render(<Probe selectedMode="bypassPermissions" selectedThinking="max" />);

    postDefault({ modes: ["auto", "plan"], efforts: ["low"] });

    expect(ids(seen.result!.modeOptions)).toEqual(["plan", "auto"]);
    expect(ids(seen.result!.thinkingOptions)).toEqual(["low"]);
    expect(seen.modeCalls).toEqual(["auto"]);
    expect(seen.thinkingCalls).toEqual(["low"]);
  });

  it("leaves an allowed selection alone", () => {
    render(<Probe selectedMode="plan" selectedThinking="low" />);

    postDefault({ modes: ["auto", "plan"], efforts: ["low"] });

    expect(seen.modeCalls).toEqual([]);
    expect(seen.thinkingCalls).toEqual([]);
  });
});
