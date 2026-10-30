// Figmenta fork (contratto notes-maestro §10.2; review 2026-10-30): the <webview> of a Google
// Doc or Slides note runs on `persist:paseo-browser`, the partition where the person is signed
// in to Google. What it may load, where its top frame may go, what it may ask for and where its
// popups go are decided here, and main.ts only wires them: a remote page that can drive a
// signed-in Google session must not be able to point it anywhere else.

/**
 * Hosts the webview's top frame may be on. [ASSUNZIONE] the sign-in flow stays on these two:
 * the smoke on the app measures it, and a host it needs is added here and nowhere else.
 */
export const GOOGLE_WEBVIEW_HOSTS: ReadonlySet<string> = new Set([
  "docs.google.com",
  "accounts.google.com",
]);

/** What a page in the partition is granted; everything else is refused, devices included. */
export const GUEST_PERMISSIONS: ReadonlySet<string> = new Set([
  "fullscreen",
  "clipboard-sanitized-write",
]);

/** `host` (with a port only when it is not 443) of an https URL; null for anything else. */
function httpsHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

/** A webview may be attached only to an https Google Docs or Slides page. */
export function isGoogleDocsWebviewSrc(src: string | undefined): boolean {
  return httpsHost(src) === "docs.google.com";
}

/** Where the webview's top frame may navigate or be redirected (https, Google hosts above). */
export function isGoogleWebviewNavigation(url: string): boolean {
  const host = httpsHost(url);
  return host !== null && GOOGLE_WEBVIEW_HOSTS.has(host);
}

export function guestPermissionPolicy(permission: string): boolean {
  return GUEST_PERMISSIONS.has(permission);
}

/** The URL to hand to the system browser for a popup or a refused navigation, or null. */
export function systemBrowserTarget(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
