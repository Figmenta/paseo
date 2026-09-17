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

function readAppVersion(): string {
  const value = process.argv.find((argument) =>
    argument.startsWith(APP_VERSION_ARGUMENT_PREFIX),
  );
  return value ? value.slice(APP_VERSION_ARGUMENT_PREFIX.length) : "";
}

contextBridge.exposeInMainWorld("orchestraDesktop", {
  version: readAppVersion(),
  platform: process.platform,
});
