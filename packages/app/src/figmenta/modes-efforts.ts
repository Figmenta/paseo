/**
 * Figmenta embed: what the `modes` and `efforts` of a `maestro.models.allow` do to the permission
 * mode and effort (thinking) selectors (docs/FIGMENTA.md, «Embed bridge v2», the hunk table names
 * every call site).
 *
 * Not part of upstream Paseo. The owner decides which permission modes and which effort levels a
 * fleet person sees. While Orchestra holds a list for an agent (its own entry, else the person's
 * default "*"), every selector of that agent lists only the ids in it, in the provider's order: the
 * composer (desktop toolbar and compact sheet), the command center's mode, plan-mode and thinking
 * groups, and the modes a profile may apply. An existing agent is only filtered: its current mode or
 * effort is never changed from here, and if the list leaves it out the trigger still names it (the
 * daemon is the defence). A draft (`/clear`, fork, new agent, new workspace) and the schedule form
 * create a new agent, so they read the "*" default and their selection is moved into the list:
 * mode "auto" if allowed, else the first allowed; effort the highest allowed in the manifest's order
 * (the order of the model's options: off, low, medium, high, xhigh, max, ultracode). Without a
 * list, or outside the embed, everything passes through untouched.
 */
import { useEffect, useMemo } from "react";
import type { AgentMode, AgentSelectOption } from "@getpaseo/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import type { AgentModeControlValue } from "@/composer/agent-controls/mode-control";
import { EMBED_MODELS_ALLOW_DEFAULT_ID, useEmbedModelsAllow } from "@/figmenta/embed";

/** The mode a new session takes when its current one is not allowed and this one is. */
export const EMBED_PREFERRED_MODE_ID = "auto";

/** Keeps the options whose id is allowed, in their own order. `undefined` = no filter, same array. */
export function filterAllowedOptions<T extends { id: string }>(
  options: T[],
  allowed: readonly string[] | undefined,
): T[] {
  if (allowed === undefined) return options;
  return options.filter((option) => allowed.includes(option.id));
}

/**
 * The mode a NEW session starts in: the selected one if allowed, else "auto" if allowed, else the
 * first allowed in the provider's order, else "" (nothing allowed: the daemon picks). No filter, or
 * no options yet (the catalog is still loading), leaves the selection alone.
 */
export function resolveAllowedModeId(input: {
  options: readonly AgentMode[];
  selectedId: string;
  allowed: readonly string[] | undefined;
}): string {
  const { options, selectedId, allowed } = input;
  if (allowed === undefined || options.length === 0) return selectedId;
  const permitted = options.filter((mode) => allowed.includes(mode.id));
  if (permitted.some((mode) => mode.id === selectedId)) return selectedId;
  if (permitted.some((mode) => mode.id === EMBED_PREFERRED_MODE_ID)) return EMBED_PREFERRED_MODE_ID;
  return permitted[0]?.id ?? "";
}

/**
 * The effort a NEW session starts with: the selected one (or, when none is selected, the model's
 * default) if allowed, else the highest allowed in the model's order, else "" (nothing allowed:
 * the daemon picks). No filter, or a model without effort options, leaves the selection alone.
 */
export function resolveAllowedEffortId(input: {
  options: readonly AgentSelectOption[];
  selectedId: string;
  allowed: readonly string[] | undefined;
}): string {
  const { options, selectedId, allowed } = input;
  if (allowed === undefined || options.length === 0) return selectedId;
  const permitted = options.filter((option) => allowed.includes(option.id));
  const effective = selectedId || options.find((option) => option.isDefault)?.id || "";
  if (permitted.some((option) => option.id === effective)) return selectedId;
  return permitted[permitted.length - 1]?.id ?? "";
}

/**
 * An existing agent's mode control, narrowed. Nothing allowed = no mode control. When the list
 * leaves out the agent's current mode, `selectedModeFallback` carries it so the trigger tells the
 * truth; the menu does not offer it.
 */
export function narrowModeControl(
  control: AgentModeControlValue | null,
  allowed: readonly string[] | undefined,
): AgentModeControlValue | null {
  if (control === null || allowed === undefined) return control;
  const modeOptions = filterAllowedOptions(control.modeOptions, allowed);
  if (modeOptions.length === 0) return null;
  const listed = modeOptions.some((mode) => mode.id === control.selectedModeId);
  const current = control.modeOptions.find((mode) => mode.id === control.selectedModeId) ?? null;
  return { ...control, modeOptions, selectedModeFallback: listed ? null : current };
}

/**
 * An existing agent's effort options, narrowed; `selectedLabel` names its current effort when the
 * list leaves it out (the trigger tells the truth, the menu does not offer it).
 */
export function narrowEffortOptions(
  options: AgentSelectOption[] | null,
  selectedId: string | null,
  allowed: readonly string[] | undefined,
): { options: AgentSelectOption[] | null; selectedLabel: string | undefined } {
  if (options === null || allowed === undefined) return { options, selectedLabel: undefined };
  const listed = filterAllowedOptions(options, allowed);
  const outside = listed.some((option) => option.id === selectedId)
    ? undefined
    : options.find((option) => option.id === selectedId);
  return {
    options: listed,
    selectedLabel: outside ? formatThinkingOptionLabel(outside) : undefined,
  };
}

/** The mode ids a profile may apply to an existing agent (a profile's other mode is dropped). */
export function narrowModeIds(
  modeIds: string[] | null,
  allowed: readonly string[] | undefined,
): string[] | null {
  if (modeIds === null || allowed === undefined) return modeIds;
  return modeIds.filter((id) => allowed.includes(id));
}

/**
 * The mode and effort menus of one existing agent, narrowed by Orchestra's word for it (its own
 * entry, else the person's default). The very same inputs when there is no list. `modes` is the
 * allowed list itself, for the profile rows (`narrowModeIds`).
 */
export function useEmbedAgentModesEfforts(input: {
  agentId: string;
  modeControl: AgentModeControlValue | null;
  thinkingOptions: AgentSelectOption[] | null;
  selectedThinkingId: string | null;
}): {
  modeControl: AgentModeControlValue | null;
  thinkingOptions: AgentSelectOption[] | null;
  thinkingFallbackLabel: string | undefined;
  modes: readonly string[] | undefined;
} {
  const { agentId, modeControl, thinkingOptions, selectedThinkingId } = input;
  const allow = useEmbedModelsAllow(agentId);
  const modes = allow?.modes;
  const efforts = allow?.efforts;
  const narrowedModeControl = useMemo(
    () => narrowModeControl(modeControl, modes),
    [modeControl, modes],
  );
  const effort = useMemo(
    () => narrowEffortOptions(thinkingOptions, selectedThinkingId, efforts),
    [efforts, selectedThinkingId, thinkingOptions],
  );
  return {
    modeControl: narrowedModeControl,
    thinkingOptions: effort.options,
    thinkingFallbackLabel: effort.selectedLabel,
    modes,
  };
}

/** The slice of a draft's form state that the modes and efforts touch. */
export interface EmbedDraftModesEffortsForm {
  modeOptions: AgentMode[];
  selectedMode: string;
  availableThinkingOptions: AgentSelectOption[];
  selectedThinkingOptionId: string;
}

/**
 * A draft's form state, narrowed: only the allowed modes and efforts are offered, and the selected
 * ones are moved into the lists (`resolveAllowedModeId`, `resolveAllowedEffortId`). Derived, not
 * dispatched: the person's saved preferences are left alone, and what is shown, what the command
 * center offers and what is submitted all read these fields. No list = the very same object.
 */
export function narrowDraftForm<T extends EmbedDraftModesEffortsForm>(
  form: T,
  modes: readonly string[] | undefined,
  efforts: readonly string[] | undefined,
): T {
  if (modes === undefined && efforts === undefined) return form;
  return {
    ...form,
    modeOptions: filterAllowedOptions(form.modeOptions, modes),
    selectedMode: resolveAllowedModeId({
      options: form.modeOptions,
      selectedId: form.selectedMode,
      allowed: modes,
    }),
    availableThinkingOptions: filterAllowedOptions(form.availableThinkingOptions, efforts),
    selectedThinkingOptionId: resolveAllowedEffortId({
      options: form.availableThinkingOptions,
      selectedId: form.selectedThinkingOptionId,
      allowed: efforts,
    }),
  };
}

/** A draft's form state narrowed by the person's default ("*"). */
export function useEmbedDraftModesEfforts<T extends EmbedDraftModesEffortsForm>(form: T): T {
  const allow = useEmbedModelsAllow(EMBED_MODELS_ALLOW_DEFAULT_ID);
  const modes = allow?.modes;
  const efforts = allow?.efforts;
  return useMemo(() => narrowDraftForm(form, modes, efforts), [efforts, form, modes]);
}

/**
 * The schedule form's Mode and Thinking fields: a schedule creates a new agent, so they follow the
 * person's default ("*") like a draft. The options are narrowed; the form's own selection is moved
 * into the lists through its setters (the form model is a store, not derived state).
 */
export function useEmbedScheduleModesEfforts(input: {
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  thinkingOptions: AgentSelectOption[];
  selectedThinkingOptionId: string;
  onSelectThinking: (thinkingOptionId: string) => void;
}): { modeOptions: AgentMode[]; thinkingOptions: AgentSelectOption[] } {
  const allow = useEmbedModelsAllow(EMBED_MODELS_ALLOW_DEFAULT_ID);
  const modes = allow?.modes;
  const efforts = allow?.efforts;
  const { modeOptions, selectedMode, onSelectMode } = input;
  const { thinkingOptions, selectedThinkingOptionId, onSelectThinking } = input;
  const modeId = resolveAllowedModeId({
    options: modeOptions,
    selectedId: selectedMode,
    allowed: modes,
  });
  const effortId = resolveAllowedEffortId({
    options: thinkingOptions,
    selectedId: selectedThinkingOptionId,
    allowed: efforts,
  });
  useEffect(() => {
    if (modeId !== selectedMode) onSelectMode(modeId);
  }, [modeId, onSelectMode, selectedMode]);
  useEffect(() => {
    if (effortId !== selectedThinkingOptionId) onSelectThinking(effortId);
  }, [effortId, onSelectThinking, selectedThinkingOptionId]);
  const allowedModeOptions = useMemo(
    () => filterAllowedOptions(modeOptions, modes),
    [modeOptions, modes],
  );
  const allowedThinkingOptions = useMemo(
    () => filterAllowedOptions(thinkingOptions, efforts),
    [efforts, thinkingOptions],
  );
  return { modeOptions: allowedModeOptions, thinkingOptions: allowedThinkingOptions };
}
