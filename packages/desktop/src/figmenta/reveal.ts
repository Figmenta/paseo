import path from "node:path";
import { realpath, stat } from "node:fs/promises";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { isOrchestraOrigin } from "./orchestra.js";

// Figmenta fork (contratto notes-maestro §10.5, 2026-10-30): the one call the remote Orchestra
// page can make into this app. A vault file path in Maestro's chat opens the Finder with that
// file selected, and nothing else: only Orchestra's own top frame may ask, only for a file that
// exists inside the vault folder the person chose here, and the Finder only selects it (it never
// opens or runs it). The page passes what the chat knows (`maestro.file.click`): the absolute
// path on the daemon's machine, the path relative to the workspace root, the raw link text.
// preload.ts names this channel without importing it (the preload loads nothing but electron).

export const REVEAL_CHANNEL = "orchestra-desktop:reveal";

const VAULT_RELATIVE_PREFIXES = ["ROOT/", "DMS/"];
const MAX_PATH_LENGTH = 4096;

export type RevealFailure = "no_vault" | "outside_vault" | "not_found" | "bad_path";
export type RevealResult = { ok: true } | { ok: false; reason: RevealFailure };

export interface RevealInput {
  path: string | null;
  rel: string | null;
  raw: string;
}

export interface VaultFs {
  realpath(target: string): Promise<string>;
  exists(target: string): Promise<boolean>;
}

export type VaultResolution = { abs: string } | { reason: RevealFailure };

function isPathText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0")
  );
}

/** The page's input, or null when it is not `{path: string|null, rel: string|null, raw: string}`. */
export function parseRevealInput(value: unknown): RevealInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { path: absolute, rel, raw } = record;
  if (absolute !== null && !isPathText(absolute)) return null;
  if (rel !== null && !isPathText(rel)) return null;
  if (!isPathText(raw)) return null;
  return { path: absolute, rel, raw };
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

/** True when `child` is `parent` itself or lies below it (lexically, no filesystem access). */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isVaultRelative(value: string): boolean {
  return (
    !path.isAbsolute(value) && VAULT_RELATIVE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

/**
 * Where in the vault the page's path points, tried in order: `path` when it is absolute, then
 * `root/rel`, then `root/raw` when `raw` is a relative `ROOT/…` or `DMS/…` path.
 * The first candidate that exists and whose real path (symlinks followed) stays under the root's
 * real path wins, and that real path is what gets revealed. Any `..` segment is refused outright
 * (`bad_path`), never normalized away. An absolute `path` written through another route to the
 * vault (macOS `/var` → `/private/var`) is still taken when its real path is under the root.
 * `not_found` only when a candidate under the root is missing and none escaped through a
 * symlink; every other miss is `outside_vault`.
 */
export async function resolveVaultPath(
  input: RevealInput,
  root: string,
  fs: VaultFs,
): Promise<VaultResolution> {
  if (!path.isAbsolute(root)) {
    return { reason: "no_vault" };
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return { reason: "no_vault" };
  }

  // `under` = lexically below the root as written or as resolved: a miss there is `not_found`.
  const candidates: Array<{ target: string; under: boolean }> = [];
  if (input.path !== null) {
    if (hasParentSegment(input.path)) return { reason: "bad_path" };
    if (path.isAbsolute(input.path)) {
      candidates.push({
        target: path.normalize(input.path),
        under: isInside(input.path, root) || isInside(input.path, realRoot),
      });
    }
  }
  if (input.rel !== null) {
    if (path.isAbsolute(input.rel) || hasParentSegment(input.rel)) return { reason: "bad_path" };
    candidates.push({ target: path.join(root, input.rel), under: true });
  }
  if (isVaultRelative(input.raw)) {
    if (hasParentSegment(input.raw)) return { reason: "bad_path" };
    candidates.push({ target: path.join(root, input.raw), under: true });
  }

  let escaped = false;
  let missingUnder = false;
  for (const candidate of candidates) {
    if (!(await fs.exists(candidate.target))) {
      missingUnder ||= candidate.under;
      continue;
    }
    let real: string;
    try {
      real = await fs.realpath(candidate.target);
    } catch {
      missingUnder ||= candidate.under;
      continue;
    }
    if (!isInside(real, realRoot)) {
      escaped = true;
      continue;
    }
    return { abs: real };
  }
  return { reason: missingUnder && !escaped ? "not_found" : "outside_vault" };
}

export interface RevealFs extends VaultFs {
  isDirectory(target: string): Promise<boolean>;
}

export const nodeRevealFs: RevealFs = {
  realpath: (target) => realpath(target),
  exists: async (target) => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (target) => {
    try {
      return (await stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** The structural slice of an `IpcMainInvokeEvent` the sender check reads. */
export interface RevealEvent {
  readonly sender: { getType(): string };
  readonly senderFrame: { readonly parent: unknown; readonly url: string } | null;
}

/**
 * Only Orchestra's own top frame, in an app window: not a subframe (an `<iframe>` of another
 * site on the page), not a `<webview>` guest (its top frame has no parent either), not a page
 * that navigated away from the Orchestra origin.
 */
export function isOrchestraTopFrame(event: RevealEvent): boolean {
  const frame = event.senderFrame;
  return (
    frame !== null &&
    frame.parent === null &&
    event.sender.getType() === "window" &&
    isOrchestraOrigin(frame.url)
  );
}

export interface RevealDeps<E extends RevealEvent = RevealEvent> {
  getVaultRoot(): Promise<string | null>;
  saveVaultRoot(root: string): Promise<void>;
  /** The folder picker; null when the person cancels. */
  chooseVaultRoot(event: E): Promise<string | null>;
  showItemInFolder(abs: string): void;
  fs?: RevealFs;
}

export function createRevealHandler<E extends RevealEvent>(
  deps: RevealDeps<E>,
): (event: E, value: unknown) => Promise<RevealResult> {
  const fs = deps.fs ?? nodeRevealFs;
  // Two clicks while the picker is open share it instead of stacking a second one.
  let choosing: Promise<string | null> | null = null;

  const chooseAndSave = async (event: E): Promise<string | null> => {
    const chosen = await deps.chooseVaultRoot(event);
    if (chosen === null || !path.isAbsolute(chosen)) return null;
    await deps.saveVaultRoot(chosen);
    return chosen;
  };

  return async (event, value) => {
    if (!isOrchestraTopFrame(event)) {
      throw new Error(`${REVEAL_CHANNEL} answers Orchestra's top frame only`);
    }
    const input = parseRevealInput(value);
    if (input === null) {
      return { ok: false, reason: "bad_path" };
    }

    // A root that is missing, or no longer a folder (moved, renamed), is asked for again.
    let root = await deps.getVaultRoot();
    if (root === null || !(await fs.isDirectory(root))) {
      choosing ??= chooseAndSave(event).finally(() => {
        choosing = null;
      });
      root = await choosing;
      if (root === null) {
        return { ok: false, reason: "no_vault" };
      }
    }

    const resolved = await resolveVaultPath(input, root, fs);
    if ("reason" in resolved) {
      return { ok: false, reason: resolved.reason };
    }
    deps.showItemInFolder(resolved.abs);
    return { ok: true };
  };
}

export function registerReveal(
  ipcMain: Pick<IpcMain, "handle">,
  deps: RevealDeps<IpcMainInvokeEvent>,
): void {
  ipcMain.handle(REVEAL_CHANNEL, createRevealHandler(deps));
}
