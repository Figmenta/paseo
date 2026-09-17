/**
 * Maestro, daemon side.
 *
 * Holds the connection to Orchestra (server/connection.ts), enforces the user's
 * profile on every session Paseo creates, keeps the Maestro skills on disk, and
 * records denied permissions. Every hook is fail-open: if Orchestra is
 * unreachable the session is created exactly as the user asked, and the reason
 * is logged.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { setConnectionRpc, statusRpc } from "./shared/maestro";
import { PLUGIN_VERSION } from "./shared/version";
import { enforceConfig } from "./server/enforce";
import { appendDenial } from "./server/denials";
import { createMaestroConnection } from "./server/connection";
import { fetchProfile } from "./server/profile";
import { denialsPath, loadState, saveState, skillsDir } from "./server/state";
import { syncSkills } from "./server/skills";

function log(message: string, detail?: unknown): void {
  if (detail === undefined) console.log(`[figmenta-maestro] ${message}`);
  else console.log(`[figmenta-maestro] ${message}`, detail);
}

export default function contribute(server: PluginServerContext) {
  const connection = createMaestroConnection({
    fetchProfile,
    loadState,
    saveState,
    log,
  });

  server.handle(setConnectionRpc, (input) => connection.setConnection(input));

  server.handle(statusRpc, async () => {
    const status = await connection.status();
    return { ...status, version: PLUGIN_VERSION };
  });

  const removeCreate = server.before("agent.create", async ({ request }) => {
    try {
      const profile = await connection.currentProfile();
      if (profile === null || profile.status !== "active") return;
      return { ...request, config: enforceConfig(request.config, profile) };
    } catch (error) {
      log("agent.create hook failed, leaving the config untouched", (error as Error).message);
      return;
    }
  });

  const removeOpen = server.before("agent.session_open", async ({ request }) => {
    try {
      const profile = await connection.currentProfile();
      if (profile === null || profile.status !== "active") return;
      const env: Record<string, string> = { ...request.env, MAESTRO_USER: profile.user.handle };
      // Fleet seats are not delivered yet (contract §6): only set the token when
      // Orchestra actually sent one.
      if (profile.seat_token !== null && profile.seat_token.length > 0) {
        env["CLAUDE_CODE_OAUTH_TOKEN"] = profile.seat_token;
      }
      try {
        const result = await syncSkills(skillsDir(), profile.skills);
        if (result.written.length > 0 || result.removed.length > 0 || result.skipped.length > 0) {
          log("skills synced", result);
        }
      } catch (error) {
        log("skill sync failed, session continues", (error as Error).message);
      }
      return { ...request, env };
    } catch (error) {
      log("agent.session_open hook failed, leaving the env untouched", (error as Error).message);
      return;
    }
  });

  const removeDenial = server.on(
    "agent.permission_resolved",
    async ({ agent, requestId, resolution }) => {
      if (resolution.behavior !== "deny") return;
      try {
        await appendDenial(denialsPath(), {
          at: new Date().toISOString(),
          agentId: agent.id,
          provider: agent.provider,
          cwd: agent.cwd,
          requestId,
          message: resolution.message,
          user: connection.handle(),
        });
      } catch (error) {
        log("could not record a denial", (error as Error).message);
      }
    },
  );

  return () => {
    connection.stop();
    removeDenial();
    removeOpen();
    removeCreate();
  };
}
