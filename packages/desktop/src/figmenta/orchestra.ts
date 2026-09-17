// Figmenta fork: the Orchestra desktop app is this Electron shell pointed at the
// remote Orchestra web app, with the local Paseo daemon running underneath and the
// `figmenta-sessions` plugin preinstalled. Everything in this module is pure so the
// policy decisions (which origin may navigate, which permission is granted, what the
// seeded `~/.paseo/config.json` looks like) are unit-testable without Electron.

export const DEFAULT_ORCHESTRA_URL = "https://orchestra.figmenta.site";
export const ORCHESTRA_PLUGIN_ID = "figmenta-sessions";

/** Hosts we still accept a top-level navigation to: Orchestra itself plus any
 * `*.figmenta.site` sibling, because the login flow can bounce through one. */
const FIGMENTA_SUFFIX = ".figmenta.site";

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

/** Top-level navigation allowlist: Orchestra, plus https `*.figmenta.site` for the
 * OIDC hop. Everything else (including http and other hosts) is refused in-window
 * and handed to the system browser. */
export function isAllowedNavigation(url: string, orchestraUrl: string = ORCHESTRA_URL): boolean {
  if (isOrchestraOrigin(url, orchestraUrl)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return parsed.hostname === "figmenta.site" || parsed.hostname.endsWith(FIGMENTA_SUFFIX);
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

/** Text-in / text-out wrapper. An unreadable or empty file is treated as `{}`:
 * the daemon rewrites the file anyway, and refusing to start over a stray byte
 * would be worse than reseeding. */
export function seedPaseoConfigText(text: string, options: SeedOptions): string {
  let parsed: unknown = {};
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = {};
    }
  }
  return `${JSON.stringify(seedPaseoConfig(parsed, options), null, 2)}\n`;
}
