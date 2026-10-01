import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  revealWindow,
  STARTUP_SPLASH_FADE_MS,
  STARTUP_SPLASH_LOAD_TIMEOUT_MS,
  StartupSplashController,
  type FrontWindowOps,
} from "./startup-splash";
import { startupSplashPageHtml, startupSplashPageUrl } from "./startup-splash-page";

function harness() {
  const splash = { fadeOutAndClose: vi.fn(), close: vi.fn(), setHidden: vi.fn() };
  const openSplash = vi.fn(() => splash);
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const controller = new StartupSplashController({
    openSplash,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    log: () => {},
  });
  const window = { reveal: vi.fn() };
  return { controller, splash, openSplash, timers, window };
}

describe("startup splash", () => {
  it("opens right away in the instance that holds the lock", () => {
    const { controller, openSplash } = harness();
    expect(controller.start({ gotSingleInstanceLock: true })).toBe(true);
    expect(openSplash).toHaveBeenCalledTimes(1);
    expect(controller.start({ gotSingleInstanceLock: true })).toBe(false);
    expect(openSplash).toHaveBeenCalledTimes(1);
  });

  it("never opens for a second instance", () => {
    const { controller, openSplash } = harness();
    expect(controller.start({ gotSingleInstanceLock: false })).toBe(false);
    expect(openSplash).not.toHaveBeenCalled();
    expect(controller.isSplashVisible()).toBe(false);
  });

  it("keeps the first window hidden until the site has loaded, then fades out over it", () => {
    const { controller, splash, window, timers } = harness();
    controller.start({ gotSingleInstanceLock: true });
    expect(controller.adoptFirstWindow(window)).toBe(true);

    controller.firstWindowReady();
    expect(window.reveal).not.toHaveBeenCalled();
    expect(splash.fadeOutAndClose).not.toHaveBeenCalled();

    controller.firstWindowLoaded();
    expect(window.reveal).toHaveBeenCalledWith({ bringToFront: true });
    expect(splash.fadeOutAndClose).toHaveBeenCalledWith(STARTUP_SPLASH_FADE_MS);
    expect(timers[0]?.cleared).toBe(true);
    expect(controller.isSplashVisible()).toBe(false);
  });

  it("shows the window anyway when the site does not load in time: no endless splash", () => {
    const { controller, splash, window, timers } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.adoptFirstWindow(window);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(STARTUP_SPLASH_LOAD_TIMEOUT_MS);

    timers[0]?.callback();
    expect(window.reveal).toHaveBeenCalledTimes(1);
    expect(splash.fadeOutAndClose).toHaveBeenCalledTimes(1);

    controller.firstWindowLoaded();
    expect(window.reveal).toHaveBeenCalledTimes(1);
  });

  it("shows the window when the load fails, instead of waiting for the timeout", () => {
    const { controller, splash, window } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.adoptFirstWindow(window);
    controller.firstWindowLoadFailed();
    expect(window.reveal).toHaveBeenCalledTimes(1);
    expect(splash.fadeOutAndClose).toHaveBeenCalledTimes(1);
  });

  it("takes the focus only on the first show of the process", () => {
    const { controller, window } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.adoptFirstWindow(window);
    controller.firstWindowLoaded();
    controller.firstWindowLoaded();
    controller.firstWindowLoadFailed();
    expect(window.reveal).toHaveBeenCalledTimes(1);

    // A later window (second-instance, menu, "Open in new window") is not adopted: the caller
    // shows it the plain way, without forcing it in front.
    const later = { reveal: vi.fn() };
    expect(controller.adoptFirstWindow(later)).toBe(false);
    expect(later.reveal).not.toHaveBeenCalled();
  });

  it("does not hold the update screen behind the site load", () => {
    const { controller, splash, window } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.updateBlocked(); // found before the window exists
    controller.adoptFirstWindow(window);
    expect(window.reveal).not.toHaveBeenCalled();
    controller.firstWindowReady();
    expect(window.reveal).toHaveBeenCalledTimes(1);
    expect(splash.fadeOutAndClose).toHaveBeenCalledTimes(1);
  });

  it("shows a ready window at once when the update screen arrives later", () => {
    const { controller, window } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.adoptFirstWindow(window);
    controller.firstWindowReady();
    expect(window.reveal).not.toHaveBeenCalled();
    controller.updateBlocked();
    expect(window.reveal).toHaveBeenCalledTimes(1);
  });

  it("gives way to the engine setup window, then shows Orchestra as soon as it can paint", () => {
    const { controller, splash, window } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.dismiss("engine setup window");
    expect(splash.close).toHaveBeenCalledTimes(1);
    controller.adoptFirstWindow(window);
    controller.firstWindowReady();
    expect(window.reveal).toHaveBeenCalledWith({ bringToFront: true });
    expect(splash.fadeOutAndClose).not.toHaveBeenCalled();
  });

  it("hides and shows the splash around a startup dialog", () => {
    const { controller, splash } = harness();
    controller.start({ gotSingleInstanceLock: true });
    controller.setHidden(true);
    controller.setHidden(false);
    expect(splash.setHidden.mock.calls).toEqual([[true], [false]]);
  });
});

describe("revealWindow", () => {
  function ops() {
    const calls: string[] = [];
    const record: FrontWindowOps = {
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
      moveTop: () => calls.push("moveTop"),
      setAlwaysOnTop: (flag) => calls.push(`setAlwaysOnTop(${flag})`),
      stealAppFocus: () => calls.push("stealAppFocus"),
    };
    return { calls, record };
  }

  it("on Windows goes topmost and back, around focus and moveTop", () => {
    const { calls, record } = ops();
    revealWindow(record, { platform: "win32", bringToFront: true });
    expect(calls).toEqual([
      "show",
      "setAlwaysOnTop(true)",
      "focus",
      "moveTop",
      "setAlwaysOnTop(false)",
    ]);
  });

  it("on macOS activates the app", () => {
    const { calls, record } = ops();
    revealWindow(record, { platform: "darwin", bringToFront: true });
    expect(calls).toEqual(["show", "stealAppFocus", "focus"]);
  });

  it("only shows when not asked to come to the front", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const { calls, record } = ops();
      revealWindow(record, { platform, bringToFront: false });
      expect(calls).toEqual(["show"]);
    }
  });
});

describe("startup splash page", () => {
  const html = startupSplashPageHtml({
    version: "1.3.7",
    logoDataUrl: "data:image/png;base64,AAAA",
  });

  it("shows the logo and the version, in English", () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(">v1.3.7</div>");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("runs no script and loads nothing from the network", () => {
    expect(html).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("refuses a logo that is not an inline PNG, and escapes the version", () => {
    const other = startupSplashPageHtml({
      version: '1"<x>',
      logoDataUrl: "https://example.com/logo.png",
    });
    expect(other).not.toContain("example.com");
    expect(other).toContain("v1&#34;&#60;x&#62;");
  });

  it("is served as a data: URL", () => {
    expect(startupSplashPageUrl({ version: "1.0.0", logoDataUrl: null })).toMatch(
      /^data:text\/html;charset=utf-8,/,
    );
  });
});

describe("main.ts wiring", () => {
  const source = readFileSync(path.join(__dirname, "..", "main.ts"), "utf8");
  const bootstrap = source.slice(source.indexOf("async function bootstrap()"));

  it("opens the splash after the single-instance gate and right after whenReady", () => {
    const gate = bootstrap.indexOf("if (!setupSingleInstanceLock())");
    const ready = bootstrap.indexOf("await app.whenReady();");
    const splash = bootstrap.indexOf("showStartupSplash(");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThan(gate);
    expect(splash).toBeGreaterThan(ready);
    // Before the engine and the first window.
    expect(splash).toBeLessThan(bootstrap.indexOf("await startOrchestraDaemon();"));
    expect(splash).toBeLessThan(bootstrap.indexOf("desktopWindowOwner.openPrimary("));
  });

  it("hands every new window to the splash, which adopts only the first one", () => {
    expect(source).toContain("if (!adoptFirstOrchestraWindow(mainWindow)) {");
  });
});
