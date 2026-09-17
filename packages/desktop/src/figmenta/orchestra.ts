// Figmenta fork: the Orchestra desktop app is this Electron shell pointed at the
// remote Orchestra web app, with the local Paseo daemon running underneath and the
// `figmenta-sessions` plugin preinstalled. Everything in this module is pure so the
// policy decisions (which origin may navigate, which permission is granted, what the
// seeded `~/.paseo/config.json` looks like) are unit-testable without Electron.

export const DEFAULT_ORCHESTRA_URL = "https://orchestra.figmenta.site";
export const ORCHESTRA_PLUGIN_ID = "figmenta-sessions";

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
  const list = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : null;
  if (!list) return false;
  return list.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { id?: unknown }).id === pluginId &&
      (entry as { status?: unknown }).status === "running",
  );
}

export function resolveOrchestraUrl(
  env: Record<string, string | undefined> = process.env,
): string {
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
 * app's. Upstream restarted any `desktopManaged` daemon; Orchestra shares ~/.paseo with
 * an installed Paseo Desktop, so a daemon we did not spawn is reused as-is — killing
 * someone else's daemon to align a version number is not ours to do.
 */
export function shouldRestartDaemonForVersion(input: {
  spawnedByThisApp: boolean;
  desktopManaged: boolean;
  appVersion: string | null;
  daemonVersion: string | null;
}): boolean {
  if (!input.spawnedByThisApp || !input.desktopManaged) return false;
  const app = input.appVersion?.trim().replace(/^v/i, "") || null;
  const daemon = input.daemonVersion?.trim().replace(/^v/i, "") || null;
  return Boolean(app && daemon && app !== daemon);
}

// ---------------------------------------------------------------------------
// ~/.paseo/config.json seeding
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : {};
}

export interface SeedOptions {
  pluginPath: string;
  orchestraUrl?: string;
  pluginId?: string;
}

/**
 * Merge the three things the Orchestra shell needs into an existing Paseo config,
 * touching nothing else:
 *  - `pluginsEnabled: true`
 *  - `plugins[<id>]` added ONLY when absent (a user-configured entry wins, so a dev
 *    pointing the plugin at a working copy is never overwritten)
 *  - the Orchestra origin appended to `daemon.cors.allowedOrigins` when missing
 * Idempotent: seeding an already-seeded config returns an equal object.
 */
export function seedPaseoConfig(config: unknown, options: SeedOptions): JsonObject {
  const pluginId = options.pluginId ?? ORCHESTRA_PLUGIN_ID;
  const origin = orchestraOrigin(options.orchestraUrl ?? ORCHESTRA_URL);
  const next = asObject(config);

  next.pluginsEnabled = true;

  const plugins = asObject(next.plugins);
  if (plugins[pluginId] === undefined) {
    plugins[pluginId] = { source: "directory", path: options.pluginPath, enabled: true };
  }
  next.plugins = plugins;

  const daemon = asObject(next.daemon);
  const cors = asObject(daemon.cors);
  const existing = Array.isArray(cors.allowedOrigins)
    ? (cors.allowedOrigins as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  cors.allowedOrigins = existing.includes(origin) ? existing : [...existing, origin];
  daemon.cors = cors;
  next.daemon = daemon;

  return next;
}

export type SeedTextResult =
  | { status: "ok"; text: string }
  | { status: "corrupt"; reason: string };

/**
 * Text-in / text-out wrapper. A missing or empty file seeds from `{}`. A file that does
 * not parse is NOT rewritten: it may hold a hand-edited config whose only copy is that
 * file, and silently replacing it with our three keys would destroy it. The caller
 * preserves it and reports.
 */
export function seedPaseoConfigText(text: string, options: SeedOptions): SeedTextResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { status: "ok", text: `${JSON.stringify(seedPaseoConfig({}, options), null, 2)}\n` };
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
  return { status: "ok", text: `${JSON.stringify(seedPaseoConfig(parsed, options), null, 2)}\n` };
}
