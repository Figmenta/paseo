import { contextBridge, ipcRenderer } from "electron";

// Figmenta fork: this preload runs against the REMOTE Orchestra page. Upstream Paseo
// exposed `paseoDesktop` — the whole `paseo:invoke` command surface, dialogs, the browser
// automation bridge — to whatever document the window loaded. That is safe for a bundled
// local app and unacceptable for a remote origin: it would hand the desktop command set to
// anything that ever renders in this window. Orchestra gets read-only facts and, with TWO
// exceptions, nothing it can call: the app pushes the Claude Code status and the engine status
// to it, and the page sends no IPC except `orchestraDesktopActions.revealInVault` (contratto
// notes-maestro §10.5, decided 2026-10-30), which asks the app to show a vault file in the
// Finder, and `orchestraDesktopActions.restartEngine` (contratto-1321 §3), which asks the
// engine supervisor to try again now and never stops a running engine. The main process
// answers the reveal channel only for Orchestra's own top frame and only for an existing file
// inside the vault folder the person chose (figmenta/reveal.ts); preload-sandbox.test.ts pins
// this surface, so a further exposure fails the test until it is decided the same way.
//
// The preload still runs inside Electron's sandbox and is tsc-compiled (not bundled), so it
// MUST NOT import anything but "electron" (preload-sandbox.test.ts guards this).
const APP_VERSION_ARGUMENT_PREFIX = "--orchestra-app-version=";
const TITLE_BAR_INSET_ARGUMENT_PREFIX = "--orchestra-title-bar-inset=";
// claude-code-setup-electron.ts: CLAUDE_CODE_STATUS_CHANNEL and CLAUDE_CODE_STATUS_GET_CHANNEL
// (not imported: see above).
const CLAUDE_CODE_STATUS_CHANNEL = "orchestra-desktop:claude-code";
const CLAUDE_CODE_STATUS_GET_CHANNEL = "orchestra-desktop:claude-code:get";
/** Dispatched on `window` after every check, with the new `claudeCode` as `detail`. */
const CLAUDE_CODE_EVENT = "orchestra-desktop:claude-code";
// figmenta/reveal.ts: REVEAL_CHANNEL (not imported: see above).
const REVEAL_CHANNEL = "orchestra-desktop:reveal";
// figmenta/engine-status.ts: ENGINE_STATUS_CHANNEL, ENGINE_STATUS_GET_CHANNEL and
// ENGINE_RESTART_CHANNEL (not imported: see above).
const ENGINE_STATUS_CHANNEL = "orchestra-desktop:engine";
const ENGINE_STATUS_GET_CHANNEL = "orchestra-desktop:engine:get";
const ENGINE_RESTART_CHANNEL = "orchestra-desktop:engine:restart";
/** Dispatched on `window` after every change of the engine status, with it as `detail`. */
const ENGINE_EVENT = "orchestra-desktop:engine";

function readArgument(prefix: string): string {
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

// claude-code-setup.ts: ClaudeCodeReport (not imported: see above). 1.3.15 adds `latest`,
// `failure`, `platform` and `osVersion` (contratto-1315, V1).
interface ClaudeCodeStatus {
  version: string | null;
  required: string;
  ok: boolean;
  checkedAt: string;
  latest: string | null;
  failure: { message: string; detail: string; at: string } | null;
  platform: "darwin" | "win32" | "linux";
  osVersion: string;
}

function initialClaudeCodeStatus(): ClaudeCodeStatus | null {
  try {
    return (
      (ipcRenderer.sendSync(CLAUDE_CODE_STATUS_GET_CHANNEL) as ClaudeCodeStatus | null) ?? null
    );
  } catch {
    return null;
  }
}

// figmenta/engine-status.ts: EngineStatus1321 (not imported: see above). Contratto-1321 §3:
// every field always present, empty = null.
interface EngineStatus {
  state: "starting" | "running" | "error";
  version: string | null;
  target: null;
  port: number;
  serverId: string | null;
  managed: true;
  detail: string | null;
  notesDir: null;
  since: string;
  foreignStoppedAt: string | null;
}

function initialEngineStatus(): EngineStatus | null {
  try {
    return (ipcRenderer.sendSync(ENGINE_STATUS_GET_CHANNEL) as EngineStatus | null) ?? null;
  } catch {
    return null;
  }
}

const facts = {
  version: readArgument(APP_VERSION_ARGUMENT_PREFIX),
  platform: process.platform,
  // The window keeps Paseo's own title bar, so the macOS traffic lights float over the
  // top-left of the page. Orchestra reads this to indent its header by that many pixels;
  // 0 where there is nothing to avoid.
  titleBarInset: Number.parseInt(readArgument(TITLE_BAR_INSET_ARGUMENT_PREFIX), 10) || 0,
};

// `window.orchestraDesktop` is built in the page's own world, not handed over by
// contextBridge.exposeInMainWorld: what that copies is frozen at the time of the copy, and
// `claudeCode` changes after every check (claude-code-setup-electron.ts, every 30 minutes and
// on wake). It is the same read-only object as before, plus `claudeCode`, a getter on the last
// status this app pushed (null only before Orchestra's first measurement), and `engine`
// (contratto-1321 §3), a getter on the last engine status the supervisor pushed. The page can
// watch them change with addEventListener("orchestra-desktop:claude-code", ...) and
// addEventListener("orchestra-desktop:engine", ...).
contextBridge.executeInMainWorld({
  func: (
    initialFacts: { version: string; platform: string; titleBarInset: number },
    initialClaudeCode: ClaudeCodeStatus | null,
    eventName: string,
    initialEngine: EngineStatus | null,
    engineEventName: string,
  ) => {
    // Read-only all the way down: `failure` is an object of its own.
    const frozen = (status: ClaudeCodeStatus) =>
      Object.freeze({
        ...status,
        failure: status.failure ? Object.freeze({ ...status.failure }) : null,
      });
    let claudeCode = initialClaudeCode === null ? null : frozen(initialClaudeCode);
    let engine = initialEngine === null ? null : Object.freeze({ ...initialEngine });
    const api = Object.freeze(
      Object.defineProperties(
        { ...initialFacts },
        {
          claudeCode: { enumerable: true, get: () => claudeCode },
          engine: { enumerable: true, get: () => engine },
        },
      ),
    );
    Object.defineProperty(window, "orchestraDesktop", {
      value: api,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    window.addEventListener(
      eventName,
      (event) => {
        const detail = (event as CustomEvent<unknown>).detail as ClaudeCodeStatus | null;
        if (detail && typeof detail === "object" && typeof detail.required === "string") {
          claudeCode = frozen(detail);
        }
      },
      { capture: true },
    );
    window.addEventListener(
      engineEventName,
      (event) => {
        const detail = (event as CustomEvent<unknown>).detail as EngineStatus | null;
        if (detail && typeof detail === "object" && typeof detail.state === "string") {
          engine = Object.freeze({ ...detail });
        }
      },
      { capture: true },
    );
  },
  args: [facts, initialClaudeCodeStatus(), CLAUDE_CODE_EVENT, initialEngineStatus(), ENGINE_EVENT],
});

ipcRenderer.on(CLAUDE_CODE_STATUS_CHANNEL, (_event, status: ClaudeCodeStatus) => {
  contextBridge.executeInMainWorld({
    func: (next: ClaudeCodeStatus, eventName: string) => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: Object.freeze({ ...next }) }));
    },
    args: [status, CLAUDE_CODE_EVENT],
  });
});

ipcRenderer.on(ENGINE_STATUS_CHANNEL, (_event, status: EngineStatus) => {
  contextBridge.executeInMainWorld({
    func: (next: EngineStatus, eventName: string) => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: Object.freeze({ ...next }) }));
    },
    args: [status, ENGINE_EVENT],
  });
});

// figmenta/reveal.ts: RevealInput and RevealResult (not imported: see above). The input goes
// through as the page gave it: the main process validates it and trusts nothing in it.
interface RevealInput {
  path: string | null;
  rel: string | null;
  raw: string;
}
type RevealResult =
  | { ok: true }
  | { ok: false; reason: "no_vault" | "outside_vault" | "not_found" | "bad_path" };

// The two calls the page can make (see the top of this file). A separate global, so
// `window.orchestraDesktop` stays the read-only object it has always been.
contextBridge.exposeInMainWorld("orchestraDesktopActions", {
  revealInVault: (input: RevealInput): Promise<RevealResult> =>
    ipcRenderer.invoke(REVEAL_CHANNEL, input) as Promise<RevealResult>,
  restartEngine: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(ENGINE_RESTART_CHANNEL) as Promise<{ ok: boolean }>,
});
