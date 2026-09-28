import type { AppUpdater, ProgressInfo } from "electron-updater";
import type { MandatoryUpdateRuntime } from "./mandatory-update.js";
import { compareVersions } from "./semver.js";

// Figmenta fork: electron-updater behind the MandatoryUpdateRuntime interface. The updater
// instance is injected (electron-updater's `autoUpdater` in the app, a fake in the tests),
// so the configuration below — above all "never downgrade" — is unit-tested.

export type MandatoryUpdaterClient = Pick<
  AppUpdater,
  | "logger"
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "autoRunAppAfterInstall"
  | "allowDowngrade"
  | "allowPrerelease"
  | "setFeedURL"
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
  | "on"
>;

export class ElectronUpdaterRuntime implements MandatoryUpdateRuntime {
  private progressListener: ((percent: number) => void) | null = null;

  constructor(
    private readonly updater: MandatoryUpdaterClient,
    options: {
      feedUrl: string;
      currentVersion: string;
      logger: MandatoryUpdaterClient["logger"];
      onError: (message: string) => void;
    },
  ) {
    this.currentVersion = options.currentVersion;
    updater.logger = options.logger;
    updater.autoDownload = false;
    // A downloaded update that was never installed still lands at the next quit.
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    // The `channel` setter is deliberately never used: electron-updater turns
    // allowDowngrade back ON whenever a channel is assigned, which would let the feed
    // push an older build. The default channel is already "latest". allowDowngrade is
    // set last, after everything that could flip it.
    updater.setFeedURL({ provider: "generic", url: options.feedUrl });
    updater.allowDowngrade = false;
    updater.on("download-progress", (progress: ProgressInfo) => {
      this.progressListener?.(progress.percent);
    });
    // Errors reach the caller through the rejected promises below; without a listener
    // electron-updater's EventEmitter would throw on "error".
    updater.on("error", (error: Error) => {
      options.onError(error?.message ?? String(error));
    });
  }

  private readonly currentVersion: string;

  async check(): Promise<{ version: string } | null> {
    const result = await this.updater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) return null;
    const version = result.updateInfo.version;
    // Second guard, independent of electron-updater's own flags: only a strictly newer
    // version is an update.
    if (compareVersions(version, this.currentVersion) !== 1) return null;
    return { version };
  }

  async download(onProgress: (percent: number) => void): Promise<void> {
    this.progressListener = onProgress;
    try {
      await this.updater.downloadUpdate();
    } finally {
      this.progressListener = null;
    }
  }

  install(_version: string): void {
    // Silent (/S) and relaunch (--force-run) on Windows: the one-click NSIS installer
    // restarts Orchestra itself (electron-builder.yml, nsis.oneClick). macOS ignores both
    // flags and relaunches through Squirrel.
    this.updater.quitAndInstall(true, true);
  }
}
