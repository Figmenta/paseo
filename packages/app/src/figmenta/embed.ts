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
import { isWeb } from "@/constants/platform";

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
}
