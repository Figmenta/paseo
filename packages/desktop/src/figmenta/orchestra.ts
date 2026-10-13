// Figmenta fork: the Orchestra desktop app is this Electron shell pointed at the
// remote Orchestra web app, with the local Paseo daemon running underneath and the
// `figmenta-sessions` plugin preinstalled. Everything in this module is pure so the
// policy decisions (which origin may navigate, which permission is granted, what the
// seeded `~/.paseo/config.json` looks like) are unit-testable without Electron.

import { compareVersions } from "./semver.js";

export const DEFAULT_ORCHESTRA_URL = "https://orchestra.figmenta.site";
export const ORCHESTRA_PLUGIN_ID = "figmenta-sessions";
/** About panel copyright; electron-builder.yml `copyright` carries the same line. */
export const ORCHESTRA_COPYRIGHT = "© 2026 Figmenta";

/** `--bg` from the Orchestra stylesheet: the window paints the site's own background
 * while it loads, instead of a white flash. */
export const ORCHESTRA_BACKGROUND_COLOR = "#08090B";

/**
 * Height in px of the strip the macOS traffic lights occupy, handed to the page through
 * `window.orchestraDesktop.titleBarInset` so Orchestra can leave room for them. The
 * window keeps Paseo's own chrome (`titleBarStyle: "hidden"` with the traffic lights at
 * y=14), so the buttons overlap the top-left of the document unless the site indents.
 */
export function titleBarInset(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? 28 : 0;
}

/** Does this `Access-Control-Allow-Origin` value let the Orchestra page call the daemon? */
export function corsAllowsOrchestra(
  headerValue: string | null | undefined,
  orchestraUrl: string = ORCHESTRA_URL,
): boolean {
  const value = headerValue?.trim();
  if (!value) return false;
  if (value === "*") return true;
  return value.split(/[,\s]+/).includes(orchestraOrigin(orchestraUrl));
}

/** Is our plugin actually running, per `paseo plugin ls --json`? */
export function pluginIsRunning(payload: unknown, pluginId: string = ORCHESTRA_PLUGIN_ID): boolean {
  const list = pluginList(payload);
  if (!list) return false;
  return list.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { id?: unknown }).id === pluginId &&
      (entry as { status?: unknown }).status === "running",
  );
}

export function resolveOrchestraUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.ORCHESTRA_URL?.trim();
  if (!raw) return DEFAULT_ORCHESTRA_URL;
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_ORCHESTRA_URL;
  }
}

export const ORCHESTRA_URL = resolveOrchestraUrl();

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function orchestraOrigin(orchestraUrl: string = ORCHESTRA_URL): string {
  return safeOrigin(orchestraUrl) ?? safeOrigin(DEFAULT_ORCHESTRA_URL)!;
}

/** True only for the exact Orchestra origin (scheme + host + port). */
export function isOrchestraOrigin(url: string, orchestraUrl: string = ORCHESTRA_URL): boolean {
  const origin = safeOrigin(url);
  return origin !== null && origin === orchestraOrigin(orchestraUrl);
}

/**
 * Top-level navigation allowlist: the Orchestra origin and nothing else. The OIDC
 * login lives on that same host, so no sibling is needed — and a `*.figmenta.site`
 * wildcard would let any future subdomain drive this window. Everything else is
 * refused in-window and handed to the system browser.
 */
export function isAllowedNavigation(url: string, orchestraUrl: string = ORCHESTRA_URL): boolean {
  return isOrchestraOrigin(url, orchestraUrl);
}

const ALLOWED_PERMISSIONS = new Set([
  "media",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "local-network-access",
  "localNetworkAccess",
]);

/** Only the Orchestra origin gets anything, and only from the short list. */
export function permissionPolicy(origin: string, permission: string): boolean {
  if (!isOrchestraOrigin(origin)) return false;
  return ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Whether a running daemon should be restarted because its version does not match the
 * server version this app launched. Upstream restarted any `desktopManaged` daemon;
 * Orchestra shares ~/.paseo with an installed Paseo Desktop, so a daemon we did not
 * spawn is reused as-is — killing someone else's daemon to align a version number is
 * not ours to do. `expectedVersion` is a @getpaseo/server version: since 1.0.0 the
 * Orchestra app has its own version line, unrelated to the server it bundles.
 */
export function shouldRestartDaemonForVersion(input: {
  spawnedByThisApp: boolean;
  desktopManaged: boolean;
  expectedVersion: string | null;
  daemonVersion: string | null;
}): boolean {
  if (!input.spawnedByThisApp || !input.desktopManaged) return false;
  const expected = input.expectedVersion?.trim().replace(/^v/i, "") || null;
  const daemon = input.daemonVersion?.trim().replace(/^v/i, "") || null;
  return Boolean(expected && daemon && expected !== daemon);
}

// ---------------------------------------------------------------------------
// ~/.paseo/config.json seeding
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isSemver(version: string): boolean {
  return compareVersions(version, version) !== null;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : {};
}

/** What reading a plugin directory's package.json gave. */
export type PluginVersionProbe =
  | { status: "ok"; version: string }
  | { status: "missing"; reason: string };

export interface SeedOptions {
  pluginPath: string;
  orchestraUrl?: string;
  pluginId?: string;
  /**
   * Version of the plugin at `pluginPath`, the copy this app ships, read from its
   * package.json at runtime. Without it (or `probePluginVersion`) an existing entry is
   * never repointed: there is nothing to compare it with.
   */
  bundledPluginVersion?: string | null;
  /** Reads the version of the plugin directory an existing config entry points at. */
  probePluginVersion?: (pluginPath: string) => PluginVersionProbe;
}

/** An existing `plugins[<id>]` entry the seed moved to the bundled copy, and why. */
export interface PluginRepoint {
  pluginId: string;
  reason: "missing" | "older";
  fromPath: string | null;
  fromVersion: string | null;
  fromEnabled: boolean | null;
  toPath: string;
  toVersion: string;
  detail: string | null;
}

/**
 * Should an existing plugin entry be moved to the bundled copy? Only on evidence:
 *  - its directory is gone, or has no readable package.json/version ("missing") — a
 *    config written by an Orchestra that ran from a dmg volume or from Downloads;
 *  - its version is semver-LOWER than the bundled one ("older") — 2026-10-13: a config
 *    left by Desktop 0.8.1 kept every later Orchestra on plugin 0.3.0, which never asks
 *    for the seat token, so Claude Code ran "Not logged in".
 * Equal or higher (a developer's working copy), or a version that is not semver, is left
 * alone. Returns null when nothing should change.
 */
export function stalePluginEntry(
  entry: unknown,
  options: {
    bundledPath: string;
    bundledVersion: string | null | undefined;
    probe: ((pluginPath: string) => PluginVersionProbe) | undefined;
  },
): Omit<PluginRepoint, "pluginId" | "toPath" | "toVersion"> | null {
  const bundledVersion = options.bundledVersion?.trim();
  if (!bundledVersion || !options.probe) return null;
  if (!isSemver(bundledVersion)) return null;
  const record =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as JsonObject)
      : {};
  const fromPath = typeof record.path === "string" && record.path.trim() ? record.path : null;
  const fromEnabled = typeof record.enabled === "boolean" ? record.enabled : null;
  if (fromPath === options.bundledPath) return null;
  if (fromPath === null) {
    return {
      reason: "missing",
      fromPath,
      fromVersion: null,
      fromEnabled,
      detail: "entry has no path",
    };
  }
  const probed = options.probe(fromPath);
  if (probed.status === "missing") {
    return { reason: "missing", fromPath, fromVersion: null, fromEnabled, detail: probed.reason };
  }
  if (compareVersions(probed.version, bundledVersion) === -1) {
    return { reason: "older", fromPath, fromVersion: probed.version, fromEnabled, detail: null };
  }
  return null;
}

export interface SeedReport {
  config: JsonObject;
  repointed: PluginRepoint | null;
}

/**
 * Merge the three things the Orchestra shell needs into an existing Paseo config,
 * touching nothing else:
 *  - `pluginsEnabled: true`
 *  - `plugins[<id>]` added when absent, and moved to the bundled copy (enabled) when the
 *    existing entry points at a directory that is gone or holds an OLDER plugin (see
 *    `stalePluginEntry`). An entry at an equal or newer version — a dev pointing the
 *    plugin at a working copy — is never overwritten.
 *  - the Orchestra origin appended to `daemon.cors.allowedOrigins` when missing
 * Idempotent: seeding an already-seeded config returns an equal object.
 */
export function seedPaseoConfigWithReport(config: unknown, options: SeedOptions): SeedReport {
  const pluginId = options.pluginId ?? ORCHESTRA_PLUGIN_ID;
  const origin = orchestraOrigin(options.orchestraUrl ?? ORCHESTRA_URL);
  const next = asObject(config);

  next.pluginsEnabled = true;

  const plugins = asObject(next.plugins);
  const seededEntry = { source: "directory", path: options.pluginPath, enabled: true };
  let repointed: PluginRepoint | null = null;
  if (plugins[pluginId] === undefined) {
    plugins[pluginId] = seededEntry;
  } else {
    const stale = stalePluginEntry(plugins[pluginId], {
      bundledPath: options.pluginPath,
      bundledVersion: options.bundledPluginVersion,
      probe: options.probePluginVersion,
    });
    if (stale) {
      plugins[pluginId] = seededEntry;
      repointed = {
        pluginId,
        ...stale,
        toPath: options.pluginPath,
        toVersion: options.bundledPluginVersion!.trim(),
      };
    }
  }
  next.plugins = plugins;

  const daemon = asObject(next.daemon);
  const cors = asObject(daemon.cors);
  const existing = Array.isArray(cors.allowedOrigins)
    ? (cors.allowedOrigins as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  cors.allowedOrigins = existing.includes(origin) ? existing : [...existing, origin];
  daemon.cors = cors;
  next.daemon = daemon;

  return { config: next, repointed };
}

export function seedPaseoConfig(config: unknown, options: SeedOptions): JsonObject {
  return seedPaseoConfigWithReport(config, options).config;
}

export type SeedTextResult =
  | { status: "ok"; text: string; repointed: PluginRepoint | null }
  | { status: "corrupt"; reason: string };

function seededText(config: unknown, options: SeedOptions): SeedTextResult {
  const report = seedPaseoConfigWithReport(config, options);
  return {
    status: "ok",
    text: `${JSON.stringify(report.config, null, 2)}\n`,
    repointed: report.repointed,
  };
}

/**
 * Text-in / text-out wrapper. A missing or empty file seeds from `{}`. A file that does
 * not parse is NOT rewritten: it may hold a hand-edited config whose only copy is that
 * file, and silently replacing it with our three keys would destroy it. The caller
 * preserves it and reports.
 */
export function seedPaseoConfigText(text: string, options: SeedOptions): SeedTextResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return seededText({}, options);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { status: "corrupt", reason: error instanceof Error ? error.message : String(error) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "corrupt", reason: "config.json is not a JSON object" };
  }
  return seededText(parsed, options);
}

// ---------------------------------------------------------------------------
// After the daemon is up: which plugin did it actually load, and whose daemon is it?
// ---------------------------------------------------------------------------

function pluginList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return (payload as { data: unknown[] }).data;
  }
  return null;
}

/**
 * The directory the daemon loaded our plugin from, per `paseo plugin ls --json`. The
 * listing has no version field; its `path` is the daemon's in-memory config (read at
 * boot, not re-read from disk), so it names the copy that is actually running.
 */
export function loadedPluginPath(
  payload: unknown,
  pluginId: string = ORCHESTRA_PLUGIN_ID,
): string | null {
  const entry = pluginList(payload)?.find(
    (item) =>
      item !== null && typeof item === "object" && (item as { id?: unknown }).id === pluginId,
  ) as { path?: unknown } | undefined;
  return typeof entry?.path === "string" && entry.path.trim() ? entry.path : null;
}

/**
 * Is the plugin the daemon loaded older than the one this app ships? A loaded copy whose
 * version can no longer be read (its directory vanished — an unmounted dmg) counts as
 * outdated: the config now points elsewhere, and only a restart picks that up. Without a
 * readable bundled version there is nothing to compare: never outdated.
 */
export function loadedPluginIsOutdated(
  loadedVersion: string | null,
  bundledVersion: string | null,
): boolean {
  if (!bundledVersion || !isSemver(bundledVersion)) return false;
  if (!loadedVersion) return true;
  return compareVersions(loadedVersion, bundledVersion) === -1;
}

/**
 * Whose daemon holds ~/.paseo/paseo.pid:
 *  - "this-app": this Orchestra process launched it;
 *  - "orchestra": a desktop-managed daemon an earlier Orchestra launched — the instance
 *    named in `orchestra-daemon.json` (written by every Orchestra launch since 1.3.16), or
 *    a supervisor whose executable is an Orchestra install (what earlier versions launched);
 *  - "foreign": anything else — a daemon started by hand, or by an installed Paseo.app
 *    for its own sessions. Never restarted by Orchestra.
 */
export type DaemonOwner = "this-app" | "orchestra" | "foreign";

export interface DaemonLockInfo {
  pid: number;
  startedAt: string;
  desktopManaged?: boolean;
}

/**
 * File in the Paseo home naming the daemon instance (`{ pid, startedAt }` of its pid lock)
 * that an Orchestra launched. The pid lock's `desktopManaged` says "a desktop app", not
 * which one: an Orchestra may launch an installed Paseo.app's runtime, whose executable
 * is exactly Paseo's own.
 */
export const ORCHESTRA_DAEMON_MARKER_FILENAME = "orchestra-daemon.json";

/**
 * The executable of a process, from the platform probe's output. The supervisor renames
 * itself (`process.title = "Paseo Supervisor"`), which rewrites what `ps -o command=` and
 * Linux /proc/<pid>/cmdline show, so the owner is read from the executable image instead:
 *  - "lsof": `lsof -a -p <pid> -d txt -Fn` (macOS) — the first `n` field is the executable;
 *  - "proc": readlink of /proc/<pid>/exe (Linux), or `ps -o ucomm=` (macOS fallback, the
 *    executable's own name) — the output as is;
 *  - "powershell": `(Get-Process -Id <pid>).Path` (Windows).
 */
export function parseProcessExecutable(
  format: "lsof" | "proc" | "powershell",
  output: string | null | undefined,
): string | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  if (format === "lsof") {
    const name = lines.find((line) => line.startsWith("n") && line.length > 1);
    return name ? name.slice(1) : null;
  }
  return lines.find((line) => line.length > 0) ?? null;
}

const ORCHESTRA_EXECUTABLE_NAMES = new Set(["orchestra", "orchestra.exe", "orchestra helper"]);

/**
 * Is this executable an Orchestra install (any copy of it)? macOS: anything inside an
 * `Orchestra*.app/Contents/` bundle (the Helper the daemon runs on included); Windows:
 * `Orchestra.exe` or the per-user install folder `\Programs\Orchestra\`; Linux:
 * `/opt/Orchestra/` or an executable named `orchestra`. A bare name (the `ps -o ucomm=`
 * fallback) counts by name. Anything inside Paseo.app is not Orchestra.
 */
export function isOrchestraExecutable(executable: string | null | undefined): boolean {
  if (!executable) return false;
  const normalized = executable.replace(/\\/g, "/");
  if (/\/Orchestra[^/]*\.app\/Contents\//.test(normalized)) return true;
  const lower = normalized.toLowerCase();
  if (lower.includes("/programs/orchestra/") || lower.startsWith("/opt/orchestra/")) return true;
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return ORCHESTRA_EXECUTABLE_NAMES.has(base);
}

export function classifyDaemonOwner(input: {
  spawnedByThisApp: boolean;
  lock: DaemonLockInfo | null;
  marker: { pid?: unknown; startedAt?: unknown } | null;
  executable: string | null;
}): DaemonOwner {
  if (input.spawnedByThisApp) return "this-app";
  const lock = input.lock;
  if (!lock || lock.desktopManaged !== true) return "foreign";
  if (input.marker && input.marker.pid === lock.pid && input.marker.startedAt === lock.startedAt) {
    return "orchestra";
  }
  return isOrchestraExecutable(input.executable) ? "orchestra" : "foreign";
}

export type DaemonSeedAction = "ok" | "restart" | "warn";

/**
 * What to do after asking the live daemon. An outdated plugin on a daemon Orchestra
 * launched is fixed by restarting it, once, without asking: the person cannot do anything
 * useful with the question. Every other failure, and anything on a foreign daemon, warns.
 */
export function planDaemonSeedAction(input: {
  corsOk: boolean;
  pluginRunning: boolean;
  pluginOutdated: boolean;
  owner: DaemonOwner;
  alreadyRestarted: boolean;
}): DaemonSeedAction {
  if (input.corsOk && input.pluginRunning && !input.pluginOutdated) return "ok";
  if (input.pluginOutdated && input.owner !== "foreign" && !input.alreadyRestarted) {
    return "restart";
  }
  return "warn";
}

/**
 * The dialog for a check that still fails. Whether it offers "Restart engine" follows the
 * measured owner: a daemon an Orchestra launched (this process or an earlier one) can be
 * restarted from the dialog; a foreign one cannot, and the text says what to do instead.
 */
export function daemonSeedWarningText(warning: {
  kind: "seed" | "plugin-outdated";
  owner: DaemonOwner;
  loadedVersion: string | null;
  bundledVersion: string | null;
}): { message: string; detail: string; canRestart: boolean } {
  const canRestart = warning.owner !== "foreign";
  if (warning.kind === "plugin-outdated") {
    const loaded = warning.loadedVersion ? `v${warning.loadedVersion}` : "an older version";
    const bundled = warning.bundledVersion ? `v${warning.bundledVersion}` : "the current one";
    return {
      message: "The engine is running an older Orchestra plugin",
      detail: canRestart
        ? `The engine loaded the Orchestra plugin ${loaded}, but this app ships ${bundled}: Claude Code may not be signed in. Restarting it takes a few seconds.`
        : `The engine running on this machine was started outside Orchestra (for example by the Paseo app) and loaded the Orchestra plugin ${loaded}; this app ships ${bundled}. Until it restarts, Claude Code may not be signed in. Quit Paseo (or the app that started the engine) and reopen Orchestra.`,
      canRestart,
    };
  }
  return {
    message: "Engine needs a restart to load the Orchestra plugin",
    detail: canRestart
      ? "The engine is running with an older configuration. Restarting it takes a few seconds."
      : "The engine running on this machine was started outside Orchestra, so Orchestra will not restart it. Quit it (or the app that owns it) and reopen Orchestra.",
    canRestart,
  };
}
