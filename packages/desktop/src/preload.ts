import { contextBridge } from "electron";

// Figmenta fork: this preload runs against the REMOTE Orchestra page. Upstream Paseo
// exposed `paseoDesktop` — the whole `paseo:invoke` command surface, dialogs, the browser
// automation bridge — to whatever document the window loaded. That is safe for a bundled
// local app and unacceptable for a remote origin: it would hand the desktop command set to
// anything that ever renders in this window. Orchestra gets two read-only facts, no IPC.
//
// The preload still runs inside Electron's sandbox and is tsc-compiled (not bundled), so it
// MUST NOT import anything but "electron" (preload-sandbox.test.ts guards this).
const APP_VERSION_ARGUMENT_PREFIX = "--orchestra-app-version=";
const TITLE_BAR_INSET_ARGUMENT_PREFIX = "--orchestra-title-bar-inset=";

function readArgument(prefix: string): string {
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("orchestraDesktop", {
  version: readArgument(APP_VERSION_ARGUMENT_PREFIX),
  platform: process.platform,
  // The window keeps Paseo's own title bar, so the macOS traffic lights float over the
  // top-left of the page. Orchestra reads this to indent its header by that many pixels;
  // 0 where there is nothing to avoid.
  titleBarInset: Number.parseInt(readArgument(TITLE_BAR_INSET_ARGUMENT_PREFIX), 10) || 0,
});
