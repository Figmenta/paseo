// Figmenta fork: the startup splash and the first show of the Orchestra window. Pure: the
// Electron side (startup-splash-electron.ts) hands in the windows and the timers.
//
// Measured on Windows (Federico, 1.3.6 on Michelle's PC): after the one-click installer
// closes, nothing is on screen for 10-15 s (engine start + loading the remote site), then
// Orchestra opens BEHIND the other windows. So:
//   1. a small splash appears as soon as Electron is ready, before the engine starts, and
//      stays until the Orchestra page has really loaded (or a safety timeout);
//   2. it fades out over the window that replaces it;
//   3. the first window of the process is brought to the front, once. Later windows never
//      steal the focus.

/** How long the first window may take to load the site before it is shown anyway. */
export const STARTUP_SPLASH_LOAD_TIMEOUT_MS = 15_000;
/** Fade-out of the splash, once the Orchestra window is on screen. */
export const STARTUP_SPLASH_FADE_MS = 400;

export interface SplashHandle {
  /** Fades the splash out over `ms`, then closes it. */
  fadeOutAndClose(ms: number): void;
  /** Closes it at once (another window takes its place: setup, dialog). */
  close(): void;
  /** Hides it while a modal dialog of the startup is up, and shows it again. */
  setHidden(hidden: boolean): void;
}

export interface FirstWindowHandle {
  /** Shows the window; `bringToFront` asks for the one forced foreground of the process. */
  reveal(input: { bringToFront: boolean }): void;
}

export type RevealReason = "loaded" | "load-failed" | "timeout" | "update" | "ready-to-show";

export interface StartupSplashDeps {
  openSplash: () => SplashHandle | null;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  loadTimeoutMs?: number;
  fadeMs?: number;
}

export class StartupSplashController {
  private splash: SplashHandle | null = null;
  private started = false;
  private firstWindow: FirstWindowHandle | null = null;
  private firstWindowReadyToShow = false;
  private revealed = false;
  private dismissed = false;
  private updateBlocking = false;
  private timer: unknown = null;

  constructor(private readonly deps: StartupSplashDeps) {}

  /**
   * Right after `app.whenReady()`. A second instance never gets here with the lock (it quits
   * before Electron is ready), but the gate is explicit: no lock, no splash.
   */
  start(input: { gotSingleInstanceLock: boolean }): boolean {
    if (!input.gotSingleInstanceLock || this.started || this.firstWindow) return false;
    this.started = true;
    this.splash = this.deps.openSplash();
    this.deps.log("splash shown", { shown: this.splash !== null });
    return this.splash !== null;
  }

  isSplashVisible(): boolean {
    return this.splash !== null;
  }

  /**
   * The first Orchestra window of the process. Returns false for every later window: those
   * show as before (on ready-to-show) and never take the focus.
   */
  adoptFirstWindow(win: FirstWindowHandle): boolean {
    if (this.firstWindow) return false;
    this.firstWindow = win;
    this.deps.log("first window created");
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.reveal("timeout");
    }, this.deps.loadTimeoutMs ?? STARTUP_SPLASH_LOAD_TIMEOUT_MS);
    return true;
  }

  firstWindowReady(): void {
    this.firstWindowReadyToShow = true;
    if (this.updateBlocking) {
      this.reveal("update");
      return;
    }
    // Nothing on screen stands in for the window (no splash, or it gave way to the setup
    // window): waiting for the load would only bring back the empty gap.
    if (!this.splash) this.reveal("ready-to-show");
  }

  firstWindowLoaded(): void {
    this.reveal("loaded");
  }

  firstWindowLoadFailed(): void {
    this.reveal("load-failed");
  }

  /**
   * The mandatory updater covers the windows: the splash must not hide its screen nor make
   * it wait for the site, so the first window shows as soon as it can paint.
   */
  updateBlocked(): void {
    if (this.updateBlocking) return;
    this.updateBlocking = true;
    if (this.firstWindow && this.firstWindowReadyToShow) this.reveal("update");
  }

  /** Another startup window takes the splash's place (the engine setup). */
  dismiss(reason: string): void {
    if (!this.splash) return;
    this.dismissed = true;
    this.splash.close();
    this.splash = null;
    this.deps.log("splash dismissed", { reason });
  }

  setHidden(hidden: boolean): void {
    this.splash?.setHidden(hidden);
  }

  private reveal(reason: RevealReason): void {
    if (this.revealed || !this.firstWindow) return;
    this.revealed = true;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    const splash = this.splash;
    this.splash = null;
    // A splash that gave way to a dialog or the engine setup means that window owns the
    // focus now: the first window shows without stealing it (review of PR #3).
    const bringToFront = !this.dismissed;
    try {
      this.firstWindow.reveal({ bringToFront });
    } finally {
      // Whatever reveal throws, the splash (topmost, frameless, not closable) must go.
      splash?.fadeOutAndClose(this.deps.fadeMs ?? STARTUP_SPLASH_FADE_MS);
      this.deps.log("first window shown", { reason, splashFaded: splash !== null, bringToFront });
    }
  }
}

/** The calls that put a window in front, per platform. */
export interface FrontWindowOps {
  show(): void;
  focus(): void;
  moveTop(): void;
  setAlwaysOnTop(flag: boolean): void;
  stealAppFocus(): void;
}

/**
 * Shows a window and, when asked, forces it in front of the other applications.
 * Windows refuses SetForegroundWindow to a process that did not get the last input (the
 * installer launched us, then the user clicked elsewhere): a topmost round trip puts the
 * window above everything, then gives the z-order back. macOS: activate the app.
 */
export function revealWindow(
  ops: FrontWindowOps,
  input: { platform: NodeJS.Platform; bringToFront: boolean },
): void {
  ops.show();
  if (!input.bringToFront) return;
  if (input.platform === "win32") {
    ops.setAlwaysOnTop(true);
    try {
      ops.focus();
      ops.moveTop();
    } finally {
      // Never leave Orchestra topmost for the whole session, whatever focus/moveTop throw.
      ops.setAlwaysOnTop(false);
    }
    return;
  }
  if (input.platform === "darwin") ops.stealAppFocus();
  ops.focus();
}
