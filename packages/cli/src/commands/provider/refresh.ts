import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

// Figmenta fork: Orchestra Desktop updates Claude Code in the background while the engine runs.
// The daemon caches each provider's model catalog, and the Claude one hides models whose
// minimumClaudeCodeVersion is above the Claude Code it found: after an update the catalog has
// to be read again, without restarting the engine (and the sessions it runs).

export interface ProviderRefreshResult {
  providers: string;
  acknowledged: boolean;
}

export const providerRefreshSchema: OutputSchema<ProviderRefreshResult> = {
  idField: "providers",
  columns: [
    { header: "PROVIDERS", field: "providers" },
    { header: "ACKNOWLEDGED", field: (item) => (item.acknowledged ? "yes" : "no") },
  ],
};

export interface ProviderRefreshOptions extends CommandOptions {
  host?: string;
}

export async function runRefreshCommand(
  providers: string[],
  options: ProviderRefreshOptions,
  _command: Command,
): Promise<SingleResult<ProviderRefreshResult>> {
  const names = providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const result = await client.refreshProvidersSnapshot(
      names.length > 0 ? { providers: names } : undefined,
    );
    return {
      type: "single",
      data: {
        providers: names.length > 0 ? names.join(",") : "all",
        acknowledged: result.acknowledged,
      },
      schema: providerRefreshSchema,
    };
  } finally {
    await client.close();
  }
}
