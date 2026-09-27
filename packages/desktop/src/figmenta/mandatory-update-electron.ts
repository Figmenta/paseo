import path from "node:path";
import { app, BrowserWindow, ipcMain, WebContentsView, type WebContents } from "electron";
import log from "electron-log/main";
import { autoUpdater, type ProgressInfo } from "electron-updater";
import {
  createMandatoryUpdateController,
  resolveUpdateFeedUrl,
  type MandatoryUpdateController,
  type MandatoryUpdateRuntime,
  type MandatoryUpdateState,
  type MandatoryUpdateView,
} from "./mandatory-update.js";
import { updateOverlayPageUrl } from "./update-overlay-page.js";

// Figmenta fork: the Electron side of the mandatory updater (policy in mandatory-update.ts).
//
// Feed: electron-updater's `generic` provider. The URL is set explicitly here; the
// app-update.yml electron-builder writes into Resources still matters, because
// electron-updater reads its cache directory name from it (after-pack.js renames it so
// Orchestra never shares Paseo.app's `@getpaseodesktop-updater` cache).

function logUpdate(message: string, details?: Record<string, unknown>): void {
  log.info(`[orchestra-update] ${message}`, details ?? {});
}

class ElectronUpdaterRuntime implements MandatoryUpdateRuntime {
  private progressListener: ((percent: number) => void) | null = null;

  constructor(feedUrl: string) {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    // A downloaded update that was never installed still lands at the next quit.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.channel = "latest";
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.progressListener?.(progress.percent);
    });
    // Errors reach the caller through the rejected promises below; without a listener
    // electron-updater's EventEmitter would throw on "error".
    autoUpdater.on("error", (error) => {
      logUpdate("updater error event", { error: error?.message ?? String(error) });
    });
  }

  async check(): Promise<{ version: string } | null> {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) return null;
    return { version: result.updateInfo.version };
  }

  async download(onProgress: (percent: number) => void): Promise<void> {
    this.progressListener = onProgress;
    try {
      await autoUpdater.downloadUpdate();
    } finally {
      this.progressListener = null;
    }
  }

  install(): void {
    // Silent on Windows (the NSIS wizard would ask again what the user already chose),
    // and always relaunch. macOS ignores both flags.
    autoUpdater.quitAndInstall(true, true);
  }
}

/**
 * The covering screen: a WebContentsView stacked above the Orchestra page in EVERY window
 * (new windows opened while blocked get one too), sized to the whole content area, plus
 * a keyboard block on the page underneath. Removed only if the controller goes back to
 * idle (a retry that finds nothing newer).
 */
class UpdateOverlayView implements MandatoryUpdateView {
  private readonly overlays = new Map<BrowserWindow, WebContentsView>();
  private state: MandatoryUpdateState = { phase: "idle" };

  constructor() {
    app.on("browser-window-created", (_event, win) => {
      if (this.isBlocking()) this.attach(win);
    });
  }

  isBlocking(): boolean {
    return this.state.phase !== "idle";
  }

  isOverlay(contents: WebContents): boolean {
    for (const view of this.overlays.values()) {
      if (view.webContents === contents) return true;
    }
    return false;
  }

  getState(): MandatoryUpdateState {
    return this.state;
  }

  render(state: MandatoryUpdateState): void {
    this.state = state;
    if (state.phase === "idle") {
      for (const win of Array.from(this.overlays.keys())) this.detach(win);
      return;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!this.overlays.has(win)) this.attach(win);
    }
    for (const view of this.overlays.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send("orchestra-update:state", state);
      }
    }
  }

  private attach(win: BrowserWindow): void {
    if (win.isDestroyed() || this.overlays.has(win)) return;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "update-overlay-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    view.setBackgroundColor("#08090B");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());

    const fit = () => {
      if (win.isDestroyed()) return;
      const { width, height } = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    // Keys typed while blocked must not reach the Orchestra page underneath.
    const blockPageInput = (event: Electron.Event) => {
      if (this.isBlocking()) event.preventDefault();
    };
    const refocus = () => {
      if (!view.webContents.isDestroyed()) view.webContents.focus();
    };

    win.contentView.addChildView(view);
    fit();
    win.on("resize", fit);
    win.on("focus", refocus);
    win.webContents.on("before-input-event", blockPageInput);
    win.once("closed", () => {
      this.overlays.delete(win);
    });
    this.overlays.set(win, view);

    view.webContents.once("did-finish-load", () => {
      view.webContents.send("orchestra-update:state", this.state);
      refocus();
    });
    void view.webContents.loadURL(updateOverlayPageUrl());

    const cleanup = () => {
      win.off("resize", fit);
      win.off("focus", refocus);
      if (!win.webContents.isDestroyed()) {
        win.webContents.off("before-input-event", blockPageInput);
      }
    };
    view.webContents.once("destroyed", cleanup);
  }

  private detach(win: BrowserWindow): void {
    const view = this.overlays.get(win);
    this.overlays.delete(win);
    if (!view) return;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}

let controller: MandatoryUpdateController | null = null;

/**
 * Starts the mandatory updater: first check now, then every 30 minutes. Packaged builds
 * only — a development run has no feed and no signed bundle to replace.
 */
export function startMandatoryUpdater(options: { beforeInstall: () => Promise<void> }): void {
  if (controller) return;
  if (!app.isPackaged) {
    logUpdate("not packaged: mandatory updater disabled");
    return;
  }

  const feed = resolveUpdateFeedUrl();
  if (feed.refusedOverride) {
    log.warn("[orchestra-update] feed override refused (loopback only)", {
      override: feed.refusedOverride,
    });
  }
  logUpdate("feed", { url: feed.url, currentVersion: app.getVersion() });

  const view = new UpdateOverlayView();
  const updater = createMandatoryUpdateController({
    runtime: new ElectronUpdaterRuntime(feed.url),
    view,
    log: logUpdate,
    beforeInstall: options.beforeInstall,
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  });
  controller = updater;

  ipcMain.handle("orchestra-update:get-state", (event) =>
    view.isOverlay(event.sender) ? view.getState() : null,
  );
  ipcMain.on("orchestra-update:install", (event) => {
    if (view.isOverlay(event.sender)) void updater.install();
  });
  ipcMain.on("orchestra-update:retry", (event) => {
    if (view.isOverlay(event.sender)) void updater.retry();
  });

  updater.start();
}
