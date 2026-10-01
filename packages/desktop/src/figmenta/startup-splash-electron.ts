// Figmenta fork: Electron side of the startup splash (logic in startup-splash.ts, page in
// startup-splash-page.ts). main.ts calls showStartupSplash() right after app.whenReady() and
// hands the first Orchestra window to adoptFirstOrchestraWindow().

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import log from "electron-log/main";
import { revealWindow, StartupSplashController, type SplashHandle } from "./startup-splash.js";
import {
  STARTUP_SPLASH_HEIGHT,
  STARTUP_SPLASH_WIDTH,
  startupSplashPageUrl,
} from "./startup-splash-page.js";

const SPLASH_BACKGROUND = "#08090B";
const FADE_STEP_MS = 16;

let splashWindow: BrowserWindow | null = null;

function logSplash(event: string, data: Record<string, unknown> = {}): void {
  // ms since the process started: the startup timeline in main.log reads straight off it.
  log.info(`[startup-splash] ${event}`, { atMs: Math.round(performance.now()), ...data });
}

/** The logo shipped as `splash-logo.png` (extraResources); in development, from assets/. */
function readLogoDataUrl(): string | null {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "splash-logo.png")
    : path.resolve(__dirname, "../../assets/128x128@2x.png");
  try {
    if (!existsSync(candidate)) return null;
    return `data:image/png;base64,${readFileSync(candidate).toString("base64")}`;
  } catch (error) {
    log.warn("[startup-splash] logo unreadable", { candidate, error });
    return null;
  }
}

function openSplashWindow(): SplashHandle | null {
  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      title: "Orchestra",
      width: STARTUP_SPLASH_WIDTH,
      height: STARTUP_SPLASH_HEIGHT,
      center: true,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Never the key window, never in the taskbar: it cannot take the focus the Orchestra
      // window is given at the end, and it stays above the other apps while the engine starts.
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      backgroundColor: SPLASH_BACKGROUND,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        javascript: false,
        devTools: false,
        spellcheck: false,
      },
    });
  } catch (error) {
    log.error("[startup-splash] could not open the splash", error);
    return null;
  }
  splashWindow = win;
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  let hidden = false;
  win.once("ready-to-show", () => {
    if (win.isDestroyed() || hidden) return;
    win.showInactive();
    logSplash("splash on screen");
  });
  win.once("closed", () => {
    if (splashWindow === win) splashWindow = null;
  });
  void win
    .loadURL(startupSplashPageUrl({ version: app.getVersion(), logoDataUrl: readLogoDataUrl() }))
    .catch((error: unknown) => log.error("[startup-splash] page failed to load", error));

  let fadeTimer: NodeJS.Timeout | null = null;
  const close = () => {
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
    if (!win.isDestroyed()) win.destroy();
    logSplash("splash closed");
  };
  return {
    close,
    setHidden(next) {
      hidden = next;
      if (win.isDestroyed()) return;
      if (next) win.hide();
      else win.showInactive();
    },
    fadeOutAndClose(ms) {
      if (win.isDestroyed() || !win.isVisible() || process.platform === "linux") {
        close();
        return;
      }
      const start = Date.now();
      fadeTimer = setInterval(() => {
        if (win.isDestroyed()) return close();
        const progress = Math.min(1, (Date.now() - start) / ms);
        win.setOpacity(1 - progress);
        if (progress >= 1) close();
      }, FADE_STEP_MS);
    },
  };
}

const controller = new StartupSplashController({
  openSplash: openSplashWindow,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  log: logSplash,
});

/** Right after app.whenReady(), in the instance that holds the single-instance lock. */
export function showStartupSplash(input: { gotSingleInstanceLock: boolean }): void {
  controller.start(input);
}

export function isStartupSplashWindow(win: BrowserWindow | null | undefined): boolean {
  return win !== null && win !== undefined && win === splashWindow;
}

/**
 * The first Orchestra window: shown when the site has loaded (or on timeout, or at once for
 * the update screen), brought to the front once, while the splash fades out over it.
 * Returns false for any later window, which the caller shows as before.
 */
export function adoptFirstOrchestraWindow(win: BrowserWindow): boolean {
  const adopted = controller.adoptFirstWindow({
    reveal: ({ bringToFront }) => {
      if (win.isDestroyed()) return;
      revealWindow(
        {
          show: () => win.show(),
          focus: () => win.focus(),
          moveTop: () => win.moveTop(),
          setAlwaysOnTop: (flag) => win.setAlwaysOnTop(flag),
          stealAppFocus: () => app.focus({ steal: true }),
        },
        { platform: process.platform, bringToFront },
      );
    },
  });
  if (!adopted) return false;
  win.once("ready-to-show", () => controller.firstWindowReady());
  win.webContents.once("did-finish-load", () => controller.firstWindowLoaded());
  win.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    // -3 (ERR_ABORTED) is a navigation replaced by another one (a redirect), not a failure.
    if (isMainFrame && errorCode !== -3) controller.firstWindowLoadFailed();
  });
  return true;
}

/** The mandatory updater is about to cover the windows. */
export function notifyStartupUpdateBlocking(): void {
  controller.updateBlocked();
}

/** Another startup window (engine setup, a warning) takes the splash's place. */
export function dismissStartupSplash(reason: string): void {
  controller.dismiss(reason);
}

/** Runs a startup dialog with the splash out of its way. */
export async function withStartupSplashHidden<T>(run: () => Promise<T>): Promise<T> {
  controller.setHidden(true);
  try {
    return await run();
  } finally {
    controller.setHidden(false);
  }
}
