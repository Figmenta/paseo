/**
 * Which Orchestra this plugin is allowed to trust.
 *
 * The local daemon has no password: anything that can open its socket can call
 * `maestro.setconnection`. Without this gate a caller could point the plugin at
 * an Orchestra it controls and have `mcpServers` and `systemPrompt` injected
 * into every session the user starts. So the base URL is checked against an
 * allow-list before a single request leaves the machine.
 */

/** Production Orchestra. HTTPS only. */
export const ALLOWED_HTTPS_HOSTS: readonly string[] = ["orchestra.figmenta.site"];

/** Development and smoke runs: the loopback, on any port. */
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export class UntrustedBaseUrlError extends Error {
  constructor(readonly baseUrl: string) {
    super(`Base URL is not an allowed Orchestra: ${baseUrl}`);
    this.name = "UntrustedBaseUrlError";
  }
}

/**
 * Returns the normalized base URL (no trailing slash, no path, no credentials)
 * when it is allowed, and null when it is not.
 */
export function normalizeAllowedBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  // Credentials in the URL would travel with every request; refuse outright.
  if (url.username !== "" || url.password !== "") return null;
  // A path, a query or a fragment would be silently dropped by the caller's
  // string concatenation: refuse instead of connecting to something else.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;

  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    return ALLOWED_HTTPS_HOSTS.includes(host) ? `${url.protocol}//${url.host}` : null;
  }
  if (url.protocol === "http:") {
    const loopback = LOOPBACK_HOSTS.includes(host) || host === "::1";
    return loopback ? `${url.protocol}//${url.host}` : null;
  }
  return null;
}

export function assertAllowedBaseUrl(raw: string): string {
  const normalized = normalizeAllowedBaseUrl(raw);
  if (normalized === null) throw new UntrustedBaseUrlError(raw);
  return normalized;
}
