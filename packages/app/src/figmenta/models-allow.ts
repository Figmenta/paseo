/**
 * Figmenta embed: what a `maestro.models.allow` does to an agent's model menu
 * (docs/FIGMENTA.md, «Embed bridge v2», the hunk table names every call site).
 *
 * Not part of upstream Paseo. While Orchestra holds a list for an agent, every surface that
 * picks a model for it (the composer's model menu, desktop and compact, and the command
 * center's model group) shows only the rows whose model id is in the list, and the menu's
 * profile rows that would switch to another model are hidden. With `hidden: true` there is no
 * model selector at all: no trigger (so not even the current model's name), no sheet, no model
 * group in the command center, no profile that names a model; effort and permission mode stay.
 * The agent's current model is never changed from here, even when the list leaves it out: the
 * real defence is the daemon's, this is the menu. Without a list, or outside the embed,
 * everything passes through untouched.
 */
import { useMemo } from "react";
import type { AgentProfilePicker } from "@/agent-profiles";
import { useEmbedModelsAllow } from "@/figmenta/embed";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

const NO_MODELS: readonly string[] = [];
const NO_PROVIDERS: ProviderSelectorProvider[] = [];

/**
 * Keeps, in every provider that lists models, only the rows whose `modelId` is allowed.
 * A provider left without rows stays, so the trigger still finds the agent's provider and
 * shows its current model; loading and error providers pass through. `null` = no filter.
 */
export function filterProvidersByModelsAllow(
  providers: ProviderSelectorProvider[],
  allowed: readonly string[] | null,
): ProviderSelectorProvider[] {
  if (allowed === null) return providers;
  const ids = new Set(allowed);
  return providers.map((provider) => {
    if (provider.modelSelection.kind !== "models") return provider;
    return {
      ...provider,
      modelSelection: {
        kind: "models",
        rows: provider.modelSelection.rows.filter((row) => ids.has(row.modelId)),
      },
    };
  });
}

/**
 * Hides the profile rows that name a model outside the list. A profile that names no model
 * leaves the agent's model alone when applied, so it stays. `null` = no filter.
 */
export function filterProfilesByModelsAllow(
  profiles: AgentProfilePicker | null,
  allowed: readonly string[] | null,
): AgentProfilePicker | null {
  if (allowed === null || profiles === null) return profiles;
  const ids = new Set(allowed);
  return {
    ...profiles,
    rows: profiles.rows.filter((row) => row.modelId.length === 0 || ids.has(row.modelId)),
  };
}

/**
 * The model menu of one agent, narrowed by Orchestra's word for that agent. `hidden` = render
 * no model selector: `providers` is then empty (the command center builds no model group from
 * it) and only the profiles that name no model are left.
 */
export function useEmbedModelsAllowMenu(input: {
  agentId: string;
  providers: ProviderSelectorProvider[];
  profiles: AgentProfilePicker | null;
}): {
  providers: ProviderSelectorProvider[];
  profiles: AgentProfilePicker | null;
  hidden: boolean;
} {
  const { agentId, providers, profiles } = input;
  const allow = useEmbedModelsAllow(agentId);
  const hidden = allow?.hidden === true;
  // While hidden no model is allowed: the list Orchestra sent alongside plays no part.
  const allowed = hidden ? NO_MODELS : (allow?.models ?? null);
  const allowedProviders = useMemo(
    () => (hidden ? NO_PROVIDERS : filterProvidersByModelsAllow(providers, allowed)),
    [allowed, hidden, providers],
  );
  const allowedProfiles = useMemo(
    () => filterProfilesByModelsAllow(profiles, allowed),
    [allowed, profiles],
  );
  return { providers: allowedProviders, profiles: allowedProfiles, hidden };
}
