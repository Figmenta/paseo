import { describe, expect, it, vi } from "vitest";
import {
  createMandatoryUpdateController,
  DEFAULT_UPDATE_FEED_URL,
  shouldOfferMoveToApplications,
  resolveUpdateFeedUrl,
  UPDATE_CHECK_INTERVAL_MS,
  type MandatoryUpdateRuntime,
  type MandatoryUpdateState,
} from "./mandatory-update.js";

function harness(
  runtime: Partial<MandatoryUpdateRuntime> = {},
  options: { currentVersion?: string; failureHint?: () => "network" | "location" } = {},
) {
  const rendered: MandatoryUpdateState[] = [];
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const fullRuntime: MandatoryUpdateRuntime = {
    check: vi.fn(async () => null),
    download: vi.fn(async () => undefined),
    install: vi.fn(),
    ...runtime,
  };
  const beforeInstall = vi.fn(async () => undefined);
  const controller = createMandatoryUpdateController({
    runtime: fullRuntime,
    currentVersion: options.currentVersion ?? "1.0.0",
    failureHint: options.failureHint,
    view: { render: (state) => rendered.push(state) },
    log: () => undefined,
    beforeInstall,
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
    clearInterval: () => undefined,
  });
  return { controller, runtime: fullRuntime, rendered, intervals, beforeInstall };
}

describe("mandatory update controller", () => {
  it("checks at start and every 30 minutes", async () => {
    const { controller, runtime, intervals } = harness();
    controller.start();
    await vi.waitFor(() => expect(runtime.check).toHaveBeenCalledTimes(1));
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(UPDATE_CHECK_INTERVAL_MS);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
    intervals[0].callback();
    await vi.waitFor(() => expect(runtime.check).toHaveBeenCalledTimes(2));
  });

  it("stays out of the way when the build is current", async () => {
    const { controller, rendered } = harness();
    await controller.checkNow();
    expect(rendered).toEqual([]);
    expect(controller.getState()).toEqual({ phase: "idle" });
  });

  it("stays out of the way when the feed is unreachable, and tries again next round", async () => {
    const check = vi
      .fn<MandatoryUpdateRuntime["check"]>()
      .mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"))
      .mockResolvedValueOnce(null);
    const { controller, rendered } = harness({ check });
    await controller.checkNow();
    expect(rendered).toEqual([]);
    expect(controller.getState()).toEqual({ phase: "idle" });
    await controller.checkNow();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("blocks, downloads with progress, then offers only install", async () => {
    const download = vi.fn<MandatoryUpdateRuntime["download"]>(async (onProgress) => {
      onProgress(12.4);
      onProgress(100);
    });
    const { controller, rendered } = harness({
      check: async () => ({ version: "1.0.1" }),
      download,
    });
    await controller.checkNow();
    expect(rendered).toEqual([
      { phase: "downloading", version: "1.0.1", percent: null },
      { phase: "downloading", version: "1.0.1", percent: 12 },
      { phase: "downloading", version: "1.0.1", percent: 100 },
      { phase: "ready", version: "1.0.1" },
    ]);
  });

  it("shows the failure with a retry when the download fails, and the retry recovers", async () => {
    const download = vi
      .fn<MandatoryUpdateRuntime["download"]>()
      .mockRejectedValueOnce(new Error("HTTP 404"))
      .mockResolvedValueOnce(undefined);
    const { controller } = harness({ check: async () => ({ version: "1.0.1" }), download });
    await controller.checkNow();
    expect(controller.getState()).toEqual({
      phase: "failed",
      version: "1.0.1",
      message: "HTTP 404",
      hint: "network",
    });
    await controller.retry();
    expect(controller.getState()).toEqual({ phase: "ready", version: "1.0.1" });
  });

  it("never unblocks on a periodic round once a newer version was seen", async () => {
    const check = vi.fn(async () => ({ version: "1.0.1" }));
    const { controller } = harness({
      check,
      download: async () => {
        throw new Error("offline");
      },
    });
    await controller.checkNow();
    expect(controller.getState().phase).toBe("failed");
    await controller.checkNow();
    expect(check).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("failed");
  });

  it("a retry that cannot reach the feed unblocks: an unreachable feed never locks", async () => {
    const check = vi
      .fn<MandatoryUpdateRuntime["check"]>()
      .mockResolvedValueOnce({ version: "1.0.1" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ version: "1.0.1" });
    const { controller } = harness({
      check,
      download: async () => {
        throw new Error("HTTP 500");
      },
    });
    await controller.checkNow();
    expect(controller.getState().phase).toBe("failed");
    await controller.retry();
    expect(controller.getState()).toEqual({ phase: "idle" });
    // The next round blocks again if the update is still announced.
    await controller.checkNow();
    expect(check).toHaveBeenCalledTimes(3);
    expect(controller.getState().phase).toBe("failed");
  });

  it("never blocks on a version that is not newer than the running one", async () => {
    for (const announced of ["0.9.0", "1.0.0", "v1.0.0", "garbage"]) {
      const { controller, rendered, runtime } = harness({
        check: async () => ({ version: announced }),
      });
      await controller.checkNow();
      expect(rendered, announced).toEqual([]);
      expect(runtime.download, announced).not.toHaveBeenCalled();
    }
  });

  it("explains the location when the app cannot be updated where it runs", async () => {
    const { controller } = harness(
      {
        check: async () => ({ version: "1.0.1" }),
        download: async () => {
          throw new Error("EROFS");
        },
      },
      { failureHint: () => "location" },
    );
    await controller.checkNow();
    expect(controller.getState()).toMatchObject({ phase: "failed", hint: "location" });
  });

  it("installs only from the ready state, after stopping the daemon", async () => {
    const { controller, runtime, beforeInstall } = harness({
      check: async () => ({ version: "1.0.1" }),
    });
    await controller.install();
    expect(runtime.install).not.toHaveBeenCalled();
    await controller.checkNow();
    await controller.install();
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(runtime.install).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({ phase: "installing", version: "1.0.1" });
  });
});

describe("resolveUpdateFeedUrl", () => {
  it("defaults to the Figmenta downloads feed", () => {
    expect(resolveUpdateFeedUrl({})).toEqual({
      url: DEFAULT_UPDATE_FEED_URL,
      refusedOverride: null,
    });
    expect(DEFAULT_UPDATE_FEED_URL).toBe(
      "https://downloads.figmenta.site/orchestra-desktop/updates/",
    );
  });

  it("honours a loopback override (end-to-end tests) and adds the trailing slash", () => {
    expect(
      resolveUpdateFeedUrl({ ORCHESTRA_UPDATE_FEED_URL: "http://127.0.0.1:8123/feed" }),
    ).toEqual({ url: "http://127.0.0.1:8123/feed/", refusedOverride: null });
    expect(resolveUpdateFeedUrl({ ORCHESTRA_UPDATE_FEED_URL: "http://localhost:9/" }).url).toBe(
      "http://localhost:9/",
    );
  });

  it("refuses any override that leaves this machine", () => {
    for (const raw of [
      "https://evil.example/updates/",
      "http://127.0.0.1.evil.example/",
      "file:///tmp/feed/",
      "not a url",
    ]) {
      expect(resolveUpdateFeedUrl({ ORCHESTRA_UPDATE_FEED_URL: raw })).toEqual({
        url: DEFAULT_UPDATE_FEED_URL,
        refusedOverride: raw,
      });
    }
  });
});

describe("shouldOfferMoveToApplications", () => {
  const base = {
    platform: "darwin" as const,
    isPackaged: true,
    inApplicationsFolder: false,
    env: {},
  };

  it("offers the move for a packaged macOS app outside /Applications", () => {
    expect(shouldOfferMoveToApplications(base)).toBe(true);
  });

  it("stays quiet in /Applications, in development, on other platforms and in the e2e build", () => {
    expect(shouldOfferMoveToApplications({ ...base, inApplicationsFolder: true })).toBe(false);
    expect(shouldOfferMoveToApplications({ ...base, isPackaged: false })).toBe(false);
    expect(shouldOfferMoveToApplications({ ...base, platform: "win32" })).toBe(false);
    expect(
      shouldOfferMoveToApplications({ ...base, env: { ORCHESTRA_E2E_KEEP_LOCATION: "1" } }),
    ).toBe(false);
  });
});
