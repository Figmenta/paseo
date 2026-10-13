// Figmenta fork: the Electron side of the ~/.paseo/config.json seed and of the check that
// the live daemon actually runs with it. The decisions are pure and live in orchestra.ts;
// this module reads the files, asks the daemon, and restarts it when that is ours to do.
// main.ts calls it at boot; the dialog stays in main.ts and is handed in as `warn`.

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { net } from "electron";
import log from "electron-log/main";
import { resolvePaseoHome, writeFileAtomic } from "@getpaseo/server";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import {
  listDaemonPlugins,
  startDaemon,
  stopDesktopDaemon,
  wasDaemonSpawnedByThisApp,
} from "../daemon/daemon-manager.js";
import {
  classifyDaemonOwner,
  corsAllowsOrchestra,
  loadedPluginIsOutdated,
  loadedPluginPath,
  ORCHESTRA_DAEMON_MARKER_FILENAME,
  ORCHESTRA_URL,
  planDaemonSeedAction,
  pluginIsRunning,
  seedPaseoConfigText,
  type DaemonLockInfo,
  type DaemonOwner,
  type DaemonSeedAction,
  type PluginVersionProbe,
} from "./orchestra.js";

/** The `version` in `<pluginPath>/package.json`, or why it cannot be read. */
export function readPluginPackageVersion(pluginPath: string): PluginVersionProbe {
  const packageJsonPath = path.join(path.resolve(pluginPath), "package.json");
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf-8");
  } catch (error) {
    return {
      status: "missing",
      reason: `${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      return { status: "ok", version: pkg.version.trim() };
    }
    return { status: "missing", reason: `${packageJsonPath}: no version` };
  } catch (error) {
    return {
      status: "missing",
      reason: `${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function versionOrNull(probe: PluginVersionProbe): string | null {
  return probe.status === "ok" ? probe.version : null;
}

// The Orchestra shell is the only thing that configures this daemon, so it seeds
// ~/.paseo/config.json itself: plugins on, our plugin registered (and moved to the copy
// this app ships when the existing entry points at a vanished or older one), and the
// Orchestra origin allowed through daemon CORS.
export async function seedOrchestraDaemonConfig(input: { pluginPath: string }): Promise<void> {
  const home = resolvePaseoHome(process.env);
  const configPath = path.join(home, "config.json");
  let current = "";
  try {
    current = readFileSync(configPath, "utf-8");
  } catch {
    current = "";
  }

  const bundled = readPluginPackageVersion(input.pluginPath);
  if (bundled.status !== "ok") {
    log.error("[orchestra] the bundled plugin has no readable version: entries not compared", {
      pluginPath: input.pluginPath,
      reason: bundled.reason,
    });
  }

  const result = seedPaseoConfigText(current, {
    pluginPath: input.pluginPath,
    bundledPluginVersion: versionOrNull(bundled),
    probePluginVersion: readPluginPackageVersion,
  });
  if (result.status === "corrupt") {
    // A config we cannot parse is not ours to replace: it may be hand-edited and this
    // may be its only copy. Keep a dated copy as evidence, report, and leave it alone —
    // the daemon will refuse it too, and the log says why.
    const backupPath = `${configPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      copyFileSync(configPath, backupPath);
    } catch (error) {
      log.error("[orchestra] could not preserve the unreadable config", error);
    }
    log.error("[orchestra] config.json does not parse: not seeded, left untouched", {
      configPath,
      backupPath,
      reason: result.reason,
    });
    return;
  }

  if (result.repointed) {
    log.warn("[orchestra] plugin entry moved to the bundled copy", {
      configPath,
      ...result.repointed,
    });
  }
  if (result.text === current) {
    return;
  }
  // Atomic: a half-written config.json is a daemon that will not start.
  await writeFileAtomic(configPath, result.text);
  log.info("[orchestra] seeded daemon config", { configPath });
}

export interface DaemonSeedWarning {
  /** "plugin-outdated": the daemon loaded an older plugin than this app ships. */
  kind: "seed" | "plugin-outdated";
  owner: DaemonOwner;
  loadedVersion: string | null;
  bundledVersion: string | null;
}

export interface DaemonSeedCheck {
  action: DaemonSeedAction;
  target: string;
  corsOk: boolean;
  pluginRunning: boolean;
  loadedPath: string | null;
  loadedVersion: string | null;
  bundledVersion: string | null;
  pluginOutdated: boolean;
  owner: DaemonOwner;
  restarted: boolean;
}

function processCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readLaunchMarker(home: string): { pid?: unknown; startedAt?: unknown } | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(home, ORCHESTRA_DAEMON_MARKER_FILENAME), "utf-8"),
    ) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as { pid?: unknown; startedAt?: unknown })
      : null;
  } catch {
    return null;
  }
}

async function resolveDaemonOwner(): Promise<{ owner: DaemonOwner; lock: DaemonLockInfo | null }> {
  const home = resolvePaseoHome(process.env);
  let lock: DaemonLockInfo | null = null;
  try {
    lock = await readDaemonInstance(home);
  } catch (error) {
    log.error("[orchestra] could not read the daemon pid lock", error);
  }
  const owner = classifyDaemonOwner({
    spawnedByThisApp: wasDaemonSpawnedByThisApp(),
    lock,
    marker: readLaunchMarker(home),
    command: lock ? processCommand(lock.pid) : null,
  });
  return { owner, lock };
}

/** Stops the daemon Orchestra launched (this process or an earlier one) and starts one
 * that reads the seeded config. Returns the new listen address, or null on failure. */
async function restartOrchestraDaemon(
  owner: DaemonOwner,
  lock: DaemonLockInfo | null,
): Promise<string | null> {
  try {
    if (owner === "this-app") {
      await stopDesktopDaemon("plugin_outdated");
    } else if (owner === "orchestra" && lock) {
      await stopDesktopDaemon("plugin_outdated", { pid: lock.pid, startedAt: lock.startedAt });
    } else {
      return null;
    }
    const status = await startDaemon();
    log.info("[orchestra] engine restarted to load the bundled plugin", {
      status: status.status,
      listen: status.listen,
      pid: status.pid,
    });
    return status.listen;
  } catch (error) {
    log.error("[orchestra] engine restart for the bundled plugin failed", error);
    return null;
  }
}

// Seeding the config is a no-op on a daemon that was ALREADY running: it read its config
// at boot. So we ask the live daemon, instead of assuming: does it allow our origin, did
// it load our plugin, and is that plugin at least as new as the one this app ships? An
// outdated plugin on a daemon an Orchestra launched is restarted once, without asking. A
// daemon Orchestra did not launch is never restarted — the person is told instead.
export async function verifyOrchestraDaemonSeed(input: {
  listen: string | null;
  pluginPath: string;
  warn: (warning: DaemonSeedWarning) => void;
  alreadyRestarted?: boolean;
}): Promise<DaemonSeedCheck> {
  const target = input.listen?.trim() || "127.0.0.1:6767";
  let corsOk = false;
  try {
    const response = await net.fetch(`http://${target}/api/health`, {
      headers: { Origin: ORCHESTRA_URL },
    });
    corsOk = corsAllowsOrchestra(response.headers.get("access-control-allow-origin"));
  } catch (error) {
    log.error("[orchestra] could not reach the daemon health endpoint", { target, error });
  }

  let pluginRunning = false;
  let loadedPath: string | null = null;
  try {
    const plugins = await listDaemonPlugins();
    pluginRunning = pluginIsRunning(plugins);
    loadedPath = loadedPluginPath(plugins);
  } catch (error) {
    log.error("[orchestra] could not list the daemon plugins", error);
  }

  const bundledVersion = versionOrNull(readPluginPackageVersion(input.pluginPath));
  const loadedVersion = loadedPath ? versionOrNull(readPluginPackageVersion(loadedPath)) : null;
  // Only a plugin the daemon reports is compared: a missing entry is the seed failure below.
  const pluginOutdated =
    loadedPath !== null && loadedPluginIsOutdated(loadedVersion, bundledVersion);
  const { owner, lock } = await resolveDaemonOwner();
  const alreadyRestarted = input.alreadyRestarted === true;
  const action = planDaemonSeedAction({
    corsOk,
    pluginRunning,
    pluginOutdated,
    owner,
    alreadyRestarted,
  });
  const check: DaemonSeedCheck = {
    action,
    target,
    corsOk,
    pluginRunning,
    loadedPath,
    loadedVersion,
    bundledVersion,
    pluginOutdated,
    owner,
    restarted: alreadyRestarted,
  };

  if (action === "ok") {
    log.info("[orchestra] daemon seed verified", { target, loadedPath, loadedVersion });
    return check;
  }

  if (action === "restart") {
    log.warn("[orchestra] the daemon runs an older Orchestra plugin, restarting it", {
      target,
      owner,
      pid: lock?.pid ?? null,
      loadedPath,
      loadedVersion,
      bundledVersion,
    });
    const listen = await restartOrchestraDaemon(owner, lock);
    return verifyOrchestraDaemonSeed({
      ...input,
      listen: listen ?? input.listen,
      alreadyRestarted: true,
    });
  }

  log.error("[orchestra] the daemon is not running with the Orchestra seed", {
    target,
    corsAllowsOrchestra: corsOk,
    pluginRunning,
    loadedPath,
    loadedVersion,
    bundledVersion,
    owner,
    alreadyRestarted,
  });
  input.warn({
    kind: pluginOutdated ? "plugin-outdated" : "seed",
    owner,
    loadedVersion,
    bundledVersion,
  });
  return check;
}
