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

/** Who the Maestro is for this user. `null` means Orchestra sent no persona (v1). */
export interface EnforceablePersona {
  readonly name: string;
  readonly slug: string;
}

export interface EnforceableProfile {
  readonly models: readonly string[];
  readonly modes: readonly string[];
  readonly tools: readonly string[];
  readonly custom_instructions: string;
  readonly mcp: { readonly url: string; readonly token: string } | null;
  readonly persona?: EnforceablePersona | null | undefined;
}

/**
 * How a preamble block is recognised inside an already composed prompt, so a
 * rename replaces it instead of stacking a second one. Both halves matter: the
 * opening identifies the sentence, the tail keeps us off the user's own text.
 */
const PREAMBLE_OPENING = "You are ";
const PREAMBLE_MARK = "Maestro inside Orchestra";

function isPreamble(block: string): boolean {
  return block.startsWith(PREAMBLE_OPENING) && block.includes(PREAMBLE_MARK);
}

/**
 * The Maestro preamble. Appended to Claude Code's own preset prompt by the
 * claude provider (see referto): it adds, it does not replace.
 *
 * The persona only changes the name the agent answers to and the slash command
 * it advertises; the rules underneath are the same for everybody.
 */
export function maestroBase(persona: EnforceablePersona | null | undefined): string {
  const name = persona?.name ?? "Maestro";
  const lines = [
    `You are ${name}, the user's Maestro inside Orchestra, the Figmenta workspace.`,
    "Use the `orchestra_*` tools to read and update the user's own tasks, deadlines and blockers; never invent a task, a date or a status that a tool did not return.",
    "Use the `memory_*` tools to remember what the user tells you across sessions, and to recall it before asking again.",
    "When a fact is not in a tool result, say you do not have it instead of guessing.",
    "Answer in the language the user writes in.",
    "Use mail_recent / mail_read and discord_recent when they are available to you; if a tool answers not_configured, say so once and move on.",
  ];
  if (persona?.slug) {
    lines.push(
      `The user can type /${persona.slug} to get a briefing on their tasks, mail and Discord.`,
    );
  }
  return lines.join("\n");
}

/** The persona-less preamble, kept as a constant for callers that have no persona. */
export const MAESTRO_BASE = maestroBase(null);

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
  persona?: EnforceablePersona | null | undefined,
): string {
  // The previous value may already be a composed prompt: split it back into
  // blocks so enforcing twice (create, then resume) cannot stack a second copy
  // of the preamble or of the user's instructions. A preamble already in there
  // is REPLACED where it stands, not dropped and re-appended: after a rename it
  // carries the old name (dedup alone would leave the user with two Maestros),
  // and rebuilding it in place is what keeps composing twice a no-op.
  const base = maestroBase(persona);
  const previous = (existing ?? "").split(/\n{2,}/);
  const replaced = previous.some((block) => isPreamble(block.trim()));
  const blocks = [
    ...previous.map((block) => (isPreamble(block.trim()) ? base : block)),
    ...(replaced ? [] : [base]),
    customInstructions,
  ]
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
      ...config.mcpServers,
      maestro: {
        type: "http",
        url: profile.mcp.url,
        headers: { Authorization: `Bearer ${profile.mcp.token}` },
      },
    };
  }

  next.systemPrompt = composeSystemPrompt(
    config.systemPrompt,
    profile.custom_instructions,
    profile.persona,
  );

  return next as Config;
}
