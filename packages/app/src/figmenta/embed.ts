/**
 * Figmenta embed mode.
 *
 * Orchestra renders the Paseo web build inside a same-origin iframe and supplies
 * its own chrome: nav, session sidebar, session header. `?embed=1` on the first
 * URL tells this build to render the conversation and nothing around it.
 *
 * The flag is latched into sessionStorage on first sight, because Paseo's own
 * router rewrites the URL as soon as the deep link resolves to a workspace route
 * and the query string would be lost.
 *
 * Not part of upstream Paseo: see docs/FIGMENTA.md.
 */
import { UnistylesRuntime } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { THEME_TO_UNISTYLES } from "@/styles/theme";

const STORAGE_KEY = "figmentaEmbed";
const QUERY_KEY = "embed";

let cached: boolean | null = null;

function readFromLocation(): boolean {
  try {
    const search = window.location?.search ?? "";
    return new URLSearchParams(search).get(QUERY_KEY) === "1";
  } catch {
    return false;
  }
}

function readFromSession(): boolean {
  try {
    return window.sessionStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private mode, or a browser that denies storage to a framed document.
    return false;
  }
}

function latch(): void {
  try {
    window.sessionStorage?.setItem(STORAGE_KEY, "1");
  } catch {
    // Best effort: the in-module cache still carries the flag for this document.
  }
}

/** True when this document is the Orchestra-embedded Paseo. Always false on native. */
export function isEmbedMode(): boolean {
  if (!isWeb) return false;
  if (cached !== null) return cached;
  if (typeof window === "undefined") return false;
  const fromUrl = readFromLocation();
  if (fromUrl) latch();
  cached = fromUrl || readFromSession();
  return cached;
}

/** Test seam: forget what was read, so the next call re-reads the document. */
export function resetEmbedModeCache(): void {
  cached = null;
  cachedTheme = undefined;
}

// ---------------------------------------------------------------------------
// Embed bridge v2 — Orchestra → iframe (docs/FIGMENTA.md, «Embed bridge v2»).
//
// Orchestra owns the chrome AND the theme. Two messages come in over
// postMessage, same-origin only, and nothing goes back out:
//   { type: "maestro.composer.insert", text }  append to the active composer
//   { type: "maestro.theme", theme }           hot dark/light switch
// The theme also arrives as `?theme=dark|light` on the first URL, latched like
// `?embed=1` because the router rewrites the query away.
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "figmentaTheme";
const THEME_QUERY_KEY = "theme";
const BRIDGE_FLAG = "__figmentaEmbedBridgeInstalled";

export type EmbedTheme = "dark" | "light";

/** `undefined` = not read yet; `null` = read, and Orchestra imposed nothing. */
let cachedTheme: EmbedTheme | null | undefined;

function parseEmbedTheme(value: string | null | undefined): EmbedTheme | null {
  return value === "dark" || value === "light" ? value : null;
}

function latchTheme(theme: EmbedTheme): void {
  try {
    window.sessionStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Best effort: the in-module cache still carries it for this document.
  }
}

/**
 * The theme Orchestra imposed on this frame, or null when it imposed none.
 * Query string wins over the latch, so a reopened iframe can change its mind.
 */
export function readEmbedTheme(): EmbedTheme | null {
  if (!isWeb) return null;
  if (cachedTheme !== undefined) return cachedTheme;
  if (typeof window === "undefined") return null;

  let fromUrl: EmbedTheme | null = null;
  try {
    const search = window.location?.search ?? "";
    fromUrl = parseEmbedTheme(new URLSearchParams(search).get(THEME_QUERY_KEY));
  } catch {
    fromUrl = null;
  }
  if (fromUrl) {
    latchTheme(fromUrl);
    cachedTheme = fromUrl;
    return cachedTheme;
  }

  let fromSession: EmbedTheme | null = null;
  try {
    fromSession = parseEmbedTheme(window.sessionStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    fromSession = null;
  }
  cachedTheme = fromSession;
  return cachedTheme;
}

/** Force the Unistyles runtime onto `theme`, out of adaptive mode. Idempotent. */
export function applyEmbedTheme(theme: EmbedTheme): void {
  if (!isWeb) return;
  if (typeof window !== "undefined") latchTheme(theme);
  cachedTheme = theme;
  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[theme]);
}

/** §4 semantics: append with a single separating space, never a submit. */
export function reduceComposerInsert(draftText: string, text: string): string {
  return (draftText.length ? `${draftText.trimEnd()} ` : "") + text;
}

/**
 * True for every Paseo settings surface. In embed the host app owns settings,
 * so these routes are bounced back to the conversation.
 */
export function shouldBlockEmbedRoute(pathname: string): boolean {
  const path = (pathname || "/").split("?")[0].split("#")[0];
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "settings") return true;
  // /h/[serverId]/settings and anything under it.
  if (segments[0] === "h" && segments[2] === "settings") return true;
  return false;
}

type ComposerInsertListener = (text: string) => void;

const composerInsertListeners = new Set<ComposerInsertListener>();

/**
 * The composer hook subscribes here: the bridge lives outside React, and the
 * draft key of the active session is only known inside `useAgentInputDraft`.
 */
export function subscribeToEmbedComposerInsert(listener: ComposerInsertListener): () => void {
  composerInsertListeners.add(listener);
  return () => {
    composerInsertListeners.delete(listener);
  };
}

function emitComposerInsert(text: string): void {
  for (const listener of Array.from(composerInsertListeners)) {
    try {
      listener(text);
    } catch (error) {
      console.warn("[Figmenta] composer insert listener failed", error);
    }
  }
}

function handleEmbedMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return;
  const data = event.data as { type?: unknown; text?: unknown; theme?: unknown } | null;
  if (typeof data?.type !== "string") return;

  switch (data.type) {
    case "maestro.composer.insert": {
      if (typeof data.text !== "string" || data.text.length === 0) return;
      emitComposerInsert(data.text);
      return;
    }
    case "maestro.theme": {
      const theme = parseEmbedTheme(typeof data.theme === "string" ? data.theme : null);
      if (theme) applyEmbedTheme(theme);
      return;
    }
    default:
      // Anything else on this channel is not ours: ignore it in silence.
      return;
  }
}

/** Install the Orchestra→iframe listener. No-op off web, off embed, or twice. */
export function installEmbedBridge(): void {
  if (!isWeb || typeof window === "undefined") return;
  if (!isEmbedMode()) return;
  const host = window as Window & { [BRIDGE_FLAG]?: boolean };
  if (host[BRIDGE_FLAG]) return;
  host[BRIDGE_FLAG] = true;

  const theme = readEmbedTheme();
  if (theme) applyEmbedTheme(theme);
  window.addEventListener("message", handleEmbedMessage);
}
