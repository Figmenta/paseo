/**
 * Figmenta embed: the launcher gate (docs/FIGMENTA.md, «Launcher gate»).
 *
 * Not part of upstream Paseo. Inside Orchestra's iframe the Paseo launcher (new tab, agent,
 * terminal, terminal profiles) and every way of opening a terminal stay closed until Orchestra
 * posts `{ type: "maestro.launcher", allowed: true }`. A later `allowed: false` closes them again.
 * Outside embed mode nothing here changes Paseo's behavior.
 *
 * Every call site outside `src/figmenta/` carries the comment `// Figmenta: launcher gate`.
 */
import { useSyncExternalStore } from "react";
import { isEmbedMode } from "@/figmenta/embed";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";

/** The one message this module accepts, past the bridge's origin check. */
export const EMBED_LAUNCHER_MESSAGE_TYPE = "maestro.launcher";

/** What the frame shows wherever the launcher or a terminal would have been. */
export const EMBED_SESSION_CLOSED_MESSAGE =
  "This session is closed. Open another one from the sidebar.";

/** Refusal carried by the error `DaemonClient.createTerminal` throws while the gate is shut. */
export const EMBED_TERMINAL_REFUSED_MESSAGE = "Terminals are not available in this session.";

/** Closed by default: only an explicit `allowed: true` from Orchestra opens it. */
let launcherAllowed = false;
const listeners = new Set<() => void>();

function setLauncherAllowed(next: boolean): void {
  if (launcherAllowed === next) return;
  launcherAllowed = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.warn("[Figmenta] launcher listener failed", error);
    }
  }
}

/**
 * The `maestro.launcher` case of the bridge. `allowed` must be a boolean: anything else
 * (absent, "true", 1, null) is ignored and the previous state stays.
 */
export function applyEmbedLauncherMessage(data: { allowed?: unknown }): void {
  if (typeof data.allowed !== "boolean") return;
  setLauncherAllowed(data.allowed);
}

/** What Orchestra last said, regardless of embed mode. False until it says `allowed: true`. */
export function readEmbedLauncherAllowed(): boolean {
  return launcherAllowed;
}

export function subscribeToEmbedLauncher(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when this frame is embedded and Orchestra has not allowed the launcher. */
export function launcherLocked(): boolean {
  return isEmbedMode() && !launcherAllowed;
}

/** Re-renders the caller when Orchestra opens or closes the launcher. */
export function useEmbedLauncherAllowed(): boolean {
  return useSyncExternalStore(
    subscribeToEmbedLauncher,
    readEmbedLauncherAllowed,
    readEmbedLauncherAllowed,
  );
}

/** Render-side `launcherLocked()`: true in embed until Orchestra allows the launcher. */
export function useEmbedLauncherLocked(): boolean {
  const allowed = useEmbedLauncherAllowed();
  return isEmbedMode() && !allowed;
}

/** Test seam, and part of `resetEmbedModeCache`: per-document state Orchestra re-sends. */
export function resetEmbedLauncherLock(): void {
  setLauncherAllowed(false);
}

/**
 * Keyboard and command-palette actions that open a tab, an agent, a terminal, a browser /
 * changes / files panel, a split (which lands on the launcher), or a new workspace.
 */
export const LAUNCHER_ACTION_IDS: ReadonlySet<KeyboardActionId> = new Set<KeyboardActionId>([
  "workspace.agent.new",
  "workspace.tab.menu.open",
  "workspace.tab.open",
  "workspace.tab.target.agent",
  "workspace.tab.target.browser",
  "workspace.tab.target.changes",
  "workspace.tab.target.files",
  "workspace.terminal.new",
  "workspace.browser.new",
  "workspace.pane.split.right",
  "workspace.pane.split.down",
  "workspace.new",
  "workspace.project.pick",
  "worktree.new",
  "workspace.setup.show",
]);

/** For `keyboardActionDispatcher.dispatch`: true when the action must not reach any handler. */
export function isLauncherActionBlocked(actionId: KeyboardActionId): boolean {
  return LAUNCHER_ACTION_IDS.has(actionId) && launcherLocked();
}

/** For `DaemonClient`'s `canCreateTerminal`: permitted unless the embed gate is shut. */
export function canCreateEmbedTerminal(): boolean {
  return !launcherLocked();
}

/**
 * Agent route: kinds that render `AgentRouteResolutionView` rather than navigating away.
 * Upstream: waitingForHost, fetchingAgent, lookupError; the gate adds notFound in a locked embed.
 */
export function showsResolutionView<R extends { kind: string }>(
  resolution: R,
  locked: boolean,
): resolution is Extract<
  R,
  { kind: "waitingForHost" | "fetchingAgent" | "lookupError" | "notFound" }
> {
  const { kind } = resolution;
  if (kind === "waitingForHost" || kind === "fetchingAgent" || kind === "lookupError") return true;
  return skipsNotFoundRedirect(kind, locked);
}

/** Agent route: a missing agent in a locked embed stays on the notice, no bounce to a workspace. */
export function skipsNotFoundRedirect(kind: string, locked: boolean): boolean {
  return kind === "notFound" && locked;
}

/**
 * Command-palette root actions that `router.push` outside the dispatcher filter (add project,
 * home = open-project screen, history) or open the import sheet (import session).
 * `schedules` stays: supported in embed on purpose.
 */
export const LAUNCHER_PALETTE_ACTION_IDS: ReadonlySet<string> = new Set([
  "add-project",
  "import-session",
  "home",
  "history",
]);

/**
 * Draft ids generated in this page's lifetime (`generateDraftId`: /clear, fork). A draft tab
 * restored from the persisted layout carries an id from an earlier page, so it is not here.
 */
const sessionDraftIds = new Set<string>();

/** Called by `generateDraftId`; returns the id unchanged. */
export function noteSessionDraftId(draftId: string): string {
  sessionDraftIds.add(draftId);
  return draftId;
}

/**
 * A draft tab shows the closed-session notice only in a locked embed AND when it was restored
 * from the persisted layout; a draft created in this page (e.g. by /clear) renders normally.
 */
export function draftGatedByLauncher(draftId: string, locked: boolean): boolean {
  return locked && !sessionDraftIds.has(draftId);
}

/** The palette's root actions minus `LAUNCHER_PALETTE_ACTION_IDS` while the gate is shut. */
export function filterLauncherPaletteActions<T extends { id: string }>(
  actions: T[],
  locked: boolean,
): T[] {
  return locked ? actions.filter((action) => !LAUNCHER_PALETTE_ACTION_IDS.has(action.id)) : actions;
}
