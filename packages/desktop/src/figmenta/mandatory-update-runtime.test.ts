import { describe, expect, it, vi } from "vitest";
import { ElectronUpdaterRuntime, type MandatoryUpdaterClient } from "./mandatory-update-runtime.js";

// A stand-in with electron-updater's semantics that matter here: assigning `channel`
// turns allowDowngrade ON (AppUpdater.js), and checkForUpdates reports an older feed
// version as available exactly when allowDowngrade is on (isUpdateAvailable).
class FakeUpdater {
  allowDowngrade = false;
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  logger: unknown = null;
  feed: unknown = null;
  private _channel: string | null = null;
  constructor(
    private readonly feedVersion: string,
    private readonly currentVersion: string,
  ) {}
  get channel(): string | null {
    return this._channel;
  }
  set channel(value: string | null) {
    this._channel = value;
    this.allowDowngrade = true;
  }
  setFeedURL(options: unknown): void {
    this.feed = options;
  }
  on = vi.fn();
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
  async checkForUpdates() {
    const [f, c] = [this.feedVersion, this.currentVersion].map((v) => v.split(".").map(Number));
    const cmp = f[0] - c[0] || f[1] - c[1] || f[2] - c[2];
    const isUpdateAvailable = cmp > 0 || (cmp < 0 && this.allowDowngrade);
    return { isUpdateAvailable, updateInfo: { version: this.feedVersion } };
  }
}

function runtimeFor(feedVersion: string, currentVersion = "1.0.0") {
  const fake = new FakeUpdater(feedVersion, currentVersion);
  const runtime = new ElectronUpdaterRuntime(fake as unknown as MandatoryUpdaterClient, {
    feedUrl: "http://127.0.0.1:1/updates/",
    currentVersion,
    logger: null,
    onError: () => undefined,
  });
  return { fake, runtime };
}

describe("ElectronUpdaterRuntime", () => {
  it("a feed announcing 0.9.0 to an app on 1.0.0 is no update (no downgrade)", async () => {
    const { fake, runtime } = runtimeFor("0.9.0");
    expect(fake.allowDowngrade).toBe(false);
    await expect(runtime.check()).resolves.toBeNull();
  });

  it("refuses an older version even if the updater itself would offer it", async () => {
    const { fake, runtime } = runtimeFor("0.9.0");
    fake.allowDowngrade = true;
    await expect(runtime.check()).resolves.toBeNull();
  });

  it("reports a newer version, configured for the generic feed and explicit download", async () => {
    const { fake, runtime } = runtimeFor("1.0.1");
    await expect(runtime.check()).resolves.toEqual({ version: "1.0.1" });
    expect(fake.feed).toEqual({ provider: "generic", url: "http://127.0.0.1:1/updates/" });
    expect(fake.autoDownload).toBe(false);
    expect(fake.allowPrerelease).toBe(false);
  });

  it("the same version is no update", async () => {
    const { runtime } = runtimeFor("1.0.0");
    await expect(runtime.check()).resolves.toBeNull();
  });

  it("installs silently and asks the installer to relaunch Orchestra", () => {
    const { fake, runtime } = runtimeFor("1.0.3", "1.0.2");
    runtime.install("1.0.3");
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
