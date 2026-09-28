import { spawn } from "node:child_process";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  WebContentsView,
  type WebContents,
} from "electron";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import {
  createMandatoryUpdateController,
  resolveUpdateFeedUrl,
  shouldOfferMoveToApplications,
  type MandatoryUpdateController,
  type MandatoryUpdateState,
  type MandatoryUpdateView,
} from "./mandatory-update.js";
import { ElectronUpdaterRuntime } from "./mandatory-update-runtime.js";
import {
  needsRelaunchHelper,
  relaunchHelperEnv,
  windowsRelaunchCommand,
} from "./windows-relaunch.js";
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

function runsOutsideApplications(): boolean {
  return process.platform === "darwin" && app.isPackaged && !app.isInApplicationsFolder();
}

/**
 * Before the first window: an Orchestra outside /Applications (opened from the dmg, or a
 * copy left in Downloads) offers to move itself there, because macOS cannot update it
 * in place. Moving relaunches the app from /Applications. Declined or failed: the app
 * starts where it is, and the update screen explains the location if an update fails.
 */
export async function offerMoveToApplicationsFolder(): Promise<"moved" | "stayed"> {
  if (
    !shouldOfferMoveToApplications({
      platform: process.platform,
      isPackaged: app.isPackaged,
      inApplicationsFolder: process.platform === "darwin" && app.isInApplicationsFolder(),
      env: process.env,
    })
  ) {
    return "stayed";
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Orchestra",
    message: "Spostare Orchestra nella cartella Applicazioni?",
    detail:
      "Orchestra si aggiorna da sola, e per farlo deve stare in Applicazioni. " +
      "Da qui (per esempio dall'immagine disco) gli aggiornamenti non si possono installare.",
    buttons: ["Sposta in Applicazioni", "Non ora"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) {
    logUpdate("move to /Applications declined");
    return "stayed";
  }
  try {
    // On success the app quits and relaunches from /Applications. An existing copy there
    // is replaced (moved to the Trash); a RUNNING copy there takes focus and this one quits.
    const moved = app.moveToApplicationsFolder();
    logUpdate("move to /Applications", { moved });
    if (moved) return "moved";
  } catch (error) {
    log.error("[orchestra-update] move to /Applications failed", error);
    await dialog.showMessageBox({
      type: "warning",
      title: "Orchestra",
      message: "Non sono riuscito a spostare Orchestra in Applicazioni.",
      detail:
        "Trascina Orchestra nella cartella Applicazioni dal Finder e riaprila da lì: " +
        "altrimenti gli aggiornamenti non si possono installare.",
      buttons: ["OK"],
      noLink: true,
    });
  }
  return "stayed";
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

/**
 * Windows: start the detached relaunch helper (windows-relaunch.ts) before the installer
 * runs. Returns false — and the installer relaunches as before — if it cannot start.
 */
function startWindowsRelaunchHelper(version: string): boolean {
  if (!needsRelaunchHelper(process.platform)) return false;
  const installerPath =
    (autoUpdater as unknown as { installerPath?: string | null }).installerPath ?? null;
  const { command, args } = windowsRelaunchCommand({
    exePath: process.execPath,
    parentPid: process.pid,
    installerPath,
    targetVersion: version,
    logPath: path.join(app.getPath("logs"), "relaunch-helper.log"),
  });
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: relaunchHelperEnv(process.env),
    });
    child.on("error", (error) => {
      log.error("[orchestra-update] relaunch helper failed", error);
    });
    child.unref();
    logUpdate("relaunch helper started", {
      pid: child.pid ?? null,
      exe: process.execPath,
      installerPath,
      version,
    });
    return typeof child.pid === "number";
  } catch (error) {
    log.error("[orchestra-update] relaunch helper could not start", error);
    return false;
  }
}

function subscribeWakeEvents(onWake: (reason: "resume" | "unlock-screen" | "focus") => void): void {
  powerMonitor.on("resume", () => onWake("resume"));
  powerMonitor.on("unlock-screen", () => onWake("unlock-screen"));
  app.on("browser-window-focus", (_event, win: BrowserWindow) => {
    if (!win.isDestroyed()) onWake("focus");
  });
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
  const currentVersion = app.getVersion();
  const updater = createMandatoryUpdateController({
    runtime: new ElectronUpdaterRuntime(autoUpdater, {
      feedUrl: feed.url,
      currentVersion,
      logger: log,
      onError: (message) => logUpdate("updater error event", { error: message }),
      prepareRelaunch: startWindowsRelaunchHelper,
    }),
    currentVersion,
    failureHint: () => (runsOutsideApplications() ? "location" : "network"),
    view,
    log: logUpdate,
    beforeInstall: options.beforeInstall,
    subscribeWake: subscribeWakeEvents,
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
