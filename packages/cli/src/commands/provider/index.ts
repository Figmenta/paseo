import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { runDiagnosticCommand } from "./diagnostic.js";
import { runRefreshCommand } from "./refresh.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createProviderCommand(): Command {
  const provider = new Command("provider").description("Manage agent providers");

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List available providers and status"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name (claude, codex, opencode)")
      .option("--thinking", "Include thinking option IDs for each model"),
  ).action(withOutput(runModelsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("diagnostic")
      .description("Show provider installation, environment, and availability diagnostics")
      .argument("<provider>", "Provider name"),
  ).action(withOutput(runDiagnosticCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("refresh")
      .description("Read the providers' model catalogs again (all providers when none is named)")
      .argument("[providers...]", "Provider names (claude, codex, opencode)"),
  ).action(withOutput(runRefreshCommand));

  return provider;
}
