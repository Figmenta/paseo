import { contextBridge, ipcRenderer } from "electron";

// Figmenta fork: this preload runs against the REMOTE Orchestra page. Upstream Paseo
// exposed `paseoDesktop` — the whole `paseo:invoke` command surface, dialogs, the browser
// automation bridge — to whatever document the window loaded. That is safe for a bundled
// local app and unacceptable for a remote origin: it would hand the desktop command set to
// anything that ever renders in this window. Orchestra gets read-only facts and nothing it
// can call: the page sends no IPC at all, the app only pushes the Claude Code status to it.
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
// status this app pushed (null only before Orchestra's first measurement). The page can watch
// it change with addEventListener("orchestra-desktop:claude-code", ...).
contextBridge.executeInMainWorld({
  func: (
    initialFacts: { version: string; platform: string; titleBarInset: number },
    initialClaudeCode: ClaudeCodeStatus | null,
    eventName: string,
  ) => {
    // Read-only all the way down: `failure` is an object of its own.
    const frozen = (status: ClaudeCodeStatus) =>
      Object.freeze({
        ...status,
        failure: status.failure ? Object.freeze({ ...status.failure }) : null,
      });
    let claudeCode = initialClaudeCode === null ? null : frozen(initialClaudeCode);
    const api = Object.freeze(
      Object.defineProperty({ ...initialFacts }, "claudeCode", {
        enumerable: true,
        get: () => claudeCode,
      }),
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
  },
  args: [facts, initialClaudeCodeStatus(), CLAUDE_CODE_EVENT],
});

ipcRenderer.on(CLAUDE_CODE_STATUS_CHANNEL, (_event, status: ClaudeCodeStatus) => {
  contextBridge.executeInMainWorld({
    func: (next: ClaudeCodeStatus, eventName: string) => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: Object.freeze({ ...next }) }));
    },
    args: [status, CLAUDE_CODE_EVENT],
  });
});
