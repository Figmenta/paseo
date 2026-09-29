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
import { useSyncExternalStore } from "react";
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

/**
 * Test seam: forget what was read, so the next call re-reads the document.
 * Composer locks and model allow-lists go too: per-document state Orchestra re-sends.
 */
export function resetEmbedModeCache(): void {
  cached = null;
  cachedTheme = undefined;
  composerLocks.clear();
  modelAllowLists.clear();
}

// ---------------------------------------------------------------------------
// Embed bridge v2 — Orchestra → iframe (docs/FIGMENTA.md, «Embed bridge v2»).
//
// Orchestra owns the chrome AND the theme. Messages come in over postMessage,
// same-origin only:
//   { type: "maestro.composer.insert", text, agentId }  append, that agent only
//   { type: "maestro.composer.lock", agentId, locked, label }  read-only bar
//   { type: "maestro.models.allow", agentId, models, hidden? }  that agent's model menu;
//                                  agentId "*" = the person's default: drafts, unnamed agents
//   { type: "maestro.theme", theme }           hot dark/light switch
// One goes back out, to the parent, same origin: `{ type: "maestro.embed.ready" }`, once per
// document, as soon as the listener is up. The listener is installed by a React effect, after the
// frame's `load`, so what Orchestra posts at `load` is lost: the ready is its cue to post again.
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

const LAST_AGENT_ROUTE_KEY = "figmentaLastAgentRoute";

/** True only for `/h/<serverId>/agent/<agentId>`, the conversation surface. */
function isAgentRoute(pathname: string): boolean {
  const path = (pathname || "").split("?")[0].split("#")[0];
  const segments = path.split("/").filter(Boolean);
  return (
    segments.length === 4 &&
    segments[0] === "h" &&
    segments[2] === "agent" &&
    segments[1].length > 0 &&
    segments[3].length > 0
  );
}

/**
 * Remember the conversation the frame was last on, so a blocked route has
 * somewhere to bounce back to. Anything that is not an agent route is ignored.
 */
export function rememberAgentRoute(pathname: string): void {
  if (!isAgentRoute(pathname)) return;
  const path = (pathname || "").split("?")[0].split("#")[0];
  try {
    window.sessionStorage?.setItem(LAST_AGENT_ROUTE_KEY, path);
  } catch {
    // Storage denied to a framed document: the bounce falls back to "/".
  }
}

/** The last agent route seen in this document, or null when there was none. */
export function lastAgentRoute(): string | null {
  try {
    const stored = window.sessionStorage?.getItem(LAST_AGENT_ROUTE_KEY);
    return stored && isAgentRoute(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** §4 payload: an insert names its agent, it never means "whoever is active". */
export interface EmbedComposerInsert {
  text: string;
  agentId: string;
}

type ComposerInsertListener = (insert: EmbedComposerInsert) => void;

const composerInsertListeners = new Set<ComposerInsertListener>();

/**
 * The composer hook subscribes here: the bridge lives outside React, and the
 * draft key of the active session is only known inside `useAgentInputDraft`.
 * Every mounted composer is called: each one keeps only its own `agentId`.
 */
export function subscribeToEmbedComposerInsert(listener: ComposerInsertListener): () => void {
  composerInsertListeners.add(listener);
  return () => {
    composerInsertListeners.delete(listener);
  };
}

function emitComposerInsert(insert: EmbedComposerInsert): void {
  for (const listener of Array.from(composerInsertListeners)) {
    try {
      listener(insert);
    } catch (error) {
      console.warn("[Figmenta] composer insert listener failed", error);
    }
  }
}

/** Shown when Orchestra locks a composer without saying why (`label` null or absent). */
export const DEFAULT_COMPOSER_LOCK_LABEL = "Session expired";

/** agentId → label of the read-only bar. Absent = the composer is free. */
const composerLocks = new Map<string, string>();
const composerLockListeners = new Set<(agentId: string) => void>();

/** The label of the bar that replaces this agent's input, or null when it is not locked. */
export function readEmbedComposerLock(agentId: string): string | null {
  return composerLocks.get(agentId) ?? null;
}

/** Called with the agentId whose lock changed; read its state with `readEmbedComposerLock`. */
export function subscribeToEmbedComposerLock(listener: (agentId: string) => void): () => void {
  composerLockListeners.add(listener);
  return () => {
    composerLockListeners.delete(listener);
  };
}

/** Re-renders the caller when Orchestra locks or unlocks this agent's composer. */
export function useEmbedComposerLock(agentId: string): string | null {
  return useSyncExternalStore(
    subscribeToEmbedComposerLock,
    () => readEmbedComposerLock(agentId),
    () => readEmbedComposerLock(agentId),
  );
}

function setComposerLock(agentId: string, label: string | null): void {
  if (composerLocks.get(agentId) === (label ?? undefined)) return;
  if (label === null) composerLocks.delete(agentId);
  else composerLocks.set(agentId, label);
  for (const listener of Array.from(composerLockListeners)) {
    try {
      listener(agentId);
    } catch (error) {
      console.warn("[Figmenta] composer lock listener failed", error);
    }
  }
}

function resolveComposerLockLabel(label: unknown): string {
  return typeof label === "string" && label.trim().length > 0 ? label : DEFAULT_COMPOSER_LOCK_LABEL;
}

/**
 * The `maestro.composer.lock` case of the bridge, past the origin check. Exported so
 * the host runtime tests, which run without a window, lock an agent the same way.
 */
export function applyEmbedComposerLock(data: {
  agentId?: unknown;
  locked?: unknown;
  label?: unknown;
}): void {
  // Same rule as the insert: a lock that names no agent locks nothing.
  if (typeof data.agentId !== "string" || data.agentId.length === 0) return;
  if (data.locked === true) setComposerLock(data.agentId, resolveComposerLockLabel(data.label));
  else if (data.locked === false) setComposerLock(data.agentId, null);
}

/** What Orchestra's last `maestro.models.allow` said about one agent's model selector. */
export interface EmbedModelsAllow {
  /** The model ids the menu may show. Plays no part while `hidden`. */
  models: readonly string[];
  /** No model selector at all for this agent: the person may not switch, nor see the model. */
  hidden: boolean;
}

/**
 * The agentId of the person-level default. Orchestra names only the agents it knows; a draft
 * (`/clear`, fork, new agent) has no agentId yet, and the agent it then creates has one Orchestra
 * never named. Both take this entry. Real agent ids are never "*".
 */
export const EMBED_MODELS_ALLOW_DEFAULT_ID = "*";

/**
 * agentId → Orchestra's word on that agent's model selector, plus the default under "*".
 * Absent = no filter, the menu Paseo would show anyway. There is no message that removes an
 * entry: a new one replaces it whole (`hidden` included), a reload of the frame forgets it.
 */
const modelAllowLists = new Map<string, EmbedModelsAllow>();
const modelAllowListeners = new Set<(agentId: string) => void>();

/** Its own entry, else the person's default, else nothing: an agent's own word always wins. */
function resolveModelsAllow(agentId: string): EmbedModelsAllow | null {
  return modelAllowLists.get(agentId) ?? modelAllowLists.get(EMBED_MODELS_ALLOW_DEFAULT_ID) ?? null;
}

/**
 * Orchestra's word on this agent's model selector: its own, else the default ("*"), else null
 * (no filter). Pass `EMBED_MODELS_ALLOW_DEFAULT_ID` for a draft. Always null outside the embed.
 * Same object until a different state arrives.
 */
export function readEmbedModelsAllow(agentId: string): EmbedModelsAllow | null {
  if (!isEmbedMode()) return null;
  return resolveModelsAllow(agentId);
}

/**
 * Called with the agentId whose entry changed ("*" = the default: every draft and every agent
 * without its own entry); read the result with `readEmbedModelsAllow`.
 */
export function subscribeToEmbedModelsAllow(listener: (agentId: string) => void): () => void {
  modelAllowListeners.add(listener);
  return () => {
    modelAllowListeners.delete(listener);
  };
}

/** Re-renders the caller when Orchestra changes what this agent's model selector may show. */
export function useEmbedModelsAllow(agentId: string): EmbedModelsAllow | null {
  return useSyncExternalStore(
    subscribeToEmbedModelsAllow,
    () => readEmbedModelsAllow(agentId),
    () => readEmbedModelsAllow(agentId),
  );
}

function sameModelsAllow(
  a: EmbedModelsAllow | undefined,
  models: readonly string[],
  hidden: boolean,
): boolean {
  return (
    a !== undefined &&
    a.hidden === hidden &&
    a.models.length === models.length &&
    a.models.every((id, index) => id === models[index])
  );
}

/**
 * The `maestro.models.allow` case of the bridge, past the origin check. Malformed = ignored,
 * the previous state (or no filter) stays: no usable agentId; `hidden` present but not a
 * boolean; `models` not an array, or with an entry that is not a non-empty string; an empty
 * array while the selector is shown, since a menu with no rows helps nobody. With
 * `hidden: true` the list plays no part, so an empty one is accepted. agentId "*" is stored
 * the same way, as the default: same checks, same whole replacement.
 */
function applyEmbedModelsAllow(data: {
  agentId?: unknown;
  models?: unknown;
  hidden?: unknown;
}): void {
  if (typeof data.agentId !== "string" || data.agentId.length === 0) return;
  if (data.hidden !== undefined && typeof data.hidden !== "boolean") return;
  const hidden = data.hidden === true;
  const models = data.models;
  if (!Array.isArray(models) || (models.length === 0 && !hidden)) return;
  if (!models.every((id): id is string => typeof id === "string" && id.length > 0)) return;
  // Orchestra re-sends on every frame load, poll and session change: a repeat notifies nobody.
  if (sameModelsAllow(modelAllowLists.get(data.agentId), models, hidden)) return;
  modelAllowLists.set(data.agentId, Object.freeze({ models: Object.freeze([...models]), hidden }));
  for (const listener of Array.from(modelAllowListeners)) {
    try {
      listener(data.agentId);
    } catch (error) {
      console.warn("[Figmenta] models allow listener failed", error);
    }
  }
}

function handleEmbedMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return;
  const data = event.data as {
    type?: unknown;
    text?: unknown;
    theme?: unknown;
    agentId?: unknown;
    locked?: unknown;
    label?: unknown;
    models?: unknown;
    hidden?: unknown;
  } | null;
  if (typeof data?.type !== "string") return;

  switch (data.type) {
    case "maestro.composer.insert": {
      if (typeof data.text !== "string" || data.text.length === 0) return;
      // No agent named, no delivery: an insert without a target would land in
      // every mounted composer at once.
      if (typeof data.agentId !== "string" || data.agentId.length === 0) return;
      // A locked composer has no input to land in: the text would sit unseen
      // in the draft and resurface on unlock.
      if (composerLocks.has(data.agentId)) return;
      emitComposerInsert({ text: data.text, agentId: data.agentId });
      return;
    }
    case "maestro.composer.lock": {
      applyEmbedComposerLock(data);
      return;
    }
    case "maestro.models.allow": {
      applyEmbedModelsAllow(data);
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

/** The one message the frame sends: "my listener is up, post your per-document state now". */
export const EMBED_READY_TYPE = "maestro.embed.ready";

/** To the parent, same origin, never "*". Outside a frame the parent is this window: ignored. */
function announceEmbedReady(): void {
  try {
    window.parent.postMessage({ type: EMBED_READY_TYPE }, window.location.origin);
  } catch (error) {
    // An opaque origin ("null") is not a valid target: nobody to tell, the load post stays.
    console.warn("[Figmenta] maestro.embed.ready not posted", error);
  }
}

/**
 * Install the Orchestra→iframe listener, then tell the parent it is listening. No-op off web,
 * off embed, or twice in the same document: a reload is a new document, so a new ready.
 */
export function installEmbedBridge(): void {
  if (!isWeb || typeof window === "undefined") return;
  if (!isEmbedMode()) return;
  const host = window as Window & { [BRIDGE_FLAG]?: boolean };
  if (host[BRIDGE_FLAG]) return;
  host[BRIDGE_FLAG] = true;

  const theme = readEmbedTheme();
  if (theme) applyEmbedTheme(theme);
  window.addEventListener("message", handleEmbedMessage);
  announceEmbedReady();
}
