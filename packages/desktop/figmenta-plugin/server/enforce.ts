/**
 * Pure enforcement of a Maestro profile onto an agent session config.
 *
 * Structural types, no import from the protocol package: the rules are readable
 * and testable without a daemon.
 */

export interface EnforceableConfig {
  provider: string;
  cwd: string;
  systemPrompt?: string | undefined;
  modeId?: string | undefined;
  model?: string | undefined;
  mcpServers?: Record<string, unknown> | undefined;
}

export interface EnforceableProfile {
  readonly models: readonly string[];
  readonly modes: readonly string[];
  readonly tools: readonly string[];
  readonly custom_instructions: string;
  readonly mcp: { readonly url: string; readonly token: string } | null;
}

/**
 * The Maestro preamble. Appended to Claude Code's own preset prompt by the
 * claude provider (see referto): it adds, it does not replace.
 */
export const MAESTRO_BASE = [
  "You are the user's Maestro inside Orchestra, the Figmenta workspace.",
  "Use the `orchestra_*` tools to read and update the user's own tasks, deadlines and blockers; never invent a task, a date or a status that a tool did not return.",
  "Use the `memory_*` tools to remember what the user tells you across sessions, and to recall it before asking again.",
  "When a fact is not in a tool result, say you do not have it instead of guessing.",
  "Answer in the language the user writes in.",
].join("\n");

/** A provider string may carry the model: "claude/claude-opus-5". */
export function splitProvider(provider: string): { base: string; model: string | null } {
  const index = provider.indexOf("/");
  if (index < 0) return { base: provider, model: null };
  const model = provider.slice(index + 1).trim();
  return { base: provider.slice(0, index), model: model.length > 0 ? model : null };
}

export function composeSystemPrompt(
  existing: string | undefined,
  customInstructions: string,
): string {
  // The previous value may already be a composed prompt: split it back into
  // blocks so enforcing twice (create, then resume) cannot stack a second copy
  // of the preamble or of the user's instructions.
  const blocks = [...(existing ?? "").split(/\n{2,}/), MAESTRO_BASE, customInstructions]
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const seen = new Set<string>();
  return blocks.filter((block) => (seen.has(block) ? false : (seen.add(block), true))).join("\n\n");
}

/**
 * Applies the profile to a session config and returns a new config.
 * Empty allow-lists mean "the profile says nothing": nothing is forced.
 */
export function enforceConfig<Config extends EnforceableConfig>(
  config: Config,
  profile: EnforceableProfile,
): Config {
  const next: EnforceableConfig = { ...config };

  if (profile.models.length > 0) {
    const fromProvider = splitProvider(config.provider);
    const current = config.model ?? fromProvider.model;
    if (current === null || current === undefined || !profile.models.includes(current)) {
      const allowed = profile.models[0] as string;
      next.model = allowed;
      if (fromProvider.model !== null) next.provider = `${fromProvider.base}/${allowed}`;
    }
  }

  if (profile.modes.length > 0) {
    const fallback = profile.modes.includes("auto") ? "auto" : (profile.modes[0] as string);
    const current = config.modeId;
    if (current === undefined || !profile.modes.includes(current)) next.modeId = fallback;
  }
  // bypassPermissions is never in the catalog, and never survives enforcement.
  if (next.modeId === "bypassPermissions") {
    next.modeId = profile.modes.includes("auto") ? "auto" : (profile.modes[0] ?? "auto");
  }

  if (profile.tools.length > 0 && profile.mcp !== null) {
    next.mcpServers = {
      ...(config.mcpServers ?? {}),
      maestro: {
        type: "http",
        url: profile.mcp.url,
        headers: { Authorization: `Bearer ${profile.mcp.token}` },
      },
    };
  }

  next.systemPrompt = composeSystemPrompt(config.systemPrompt, profile.custom_instructions);

  return next as Config;
}
