// Figmenta fork (contratto-1321 §4.4): what the close button of the main window does, and
// where Orchestra lives in the system tray. Pure: tray.ts and main.ts do the Electron side.

/** Windows and Linux keep Orchestra in the system tray; macOS keeps its Dock, unchanged. */
export function usesTray(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Closing the main window on Windows and Linux hides it: the page stays loaded, so Maestro
 * and the client report go on. While the app quits (before-quit, before-quit-for-update) the
 * window closes for real, or `Quit Orchestra` and the update install could never exit.
 */
export function shouldHideOnClose(input: {
  platform: NodeJS.Platform;
  appQuitting: boolean;
  isMainWindow: boolean;
}): boolean {
  return input.isMainWindow && !input.appQuitting && usesTray(input.platform);
}

/** The tray icon in `process.resourcesPath` (electron-builder.yml extraResources). */
export function trayIconFileName(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return "icon.ico";
  if (platform === "linux") return "32x32.png";
  return null;
}
