import { describe, expect, it, vi } from "vitest";
import {
  bundlePathFromExecutable,
  INSTALL_PROGRESS_JXA,
  INSTALL_PROGRESS_MAX_SECONDS,
  INSTALL_PROGRESS_QUIT_SECONDS,
  OSASCRIPT_PATH,
  startMacInstallProgress,
} from "./install-progress-mac";

function fakeSpawn(pid = 4242) {
  const child = { pid, unref: vi.fn(), on: vi.fn() };
  const spawn = vi.fn(() => child);
  return { spawn, child };
}

describe("bundlePathFromExecutable", () => {
  it("returns the .app bundle of the main executable", () => {
    expect(bundlePathFromExecutable("/Applications/Orchestra.app/Contents/MacOS/Orchestra")).toBe(
      "/Applications/Orchestra.app",
    );
  });

  it("refuses a path outside an .app bundle", () => {
    expect(bundlePathFromExecutable("/usr/local/bin/electron")).toBeNull();
    expect(bundlePathFromExecutable("/tmp/Orchestra/Contents/MacOS/Orchestra")).toBeNull();
  });
});

describe("startMacInstallProgress", () => {
  it("runs the JXA panel through the system osascript, detached, with version and bundle", () => {
    const { spawn, child } = fakeSpawn();
    const log = vi.fn();
    const pid = startMacInstallProgress({
      version: "1.3.17",
      executablePath: "/Applications/Orchestra.app/Contents/MacOS/Orchestra",
      log,
      spawn,
    });
    expect(pid).toBe(4242);
    expect(spawn).toHaveBeenCalledWith(
      OSASCRIPT_PATH,
      [
        "-l",
        "JavaScript",
        "-e",
        INSTALL_PROGRESS_JXA,
        "1.3.17",
        "/Applications/Orchestra.app",
        String(INSTALL_PROGRESS_MAX_SECONDS),
        String(INSTALL_PROGRESS_QUIT_SECONDS),
      ],
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalled();
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("does not start outside an .app bundle", () => {
    const { spawn } = fakeSpawn();
    const log = vi.fn();
    expect(
      startMacInstallProgress({
        version: "1.3.17",
        executablePath: "/usr/bin/electron",
        log,
        spawn,
      }),
    ).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never throws when the helper cannot start: the install goes on", () => {
    const spawn = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const log = vi.fn();
    expect(
      startMacInstallProgress({
        version: "1.3.17",
        executablePath: "/Applications/Orchestra.app/Contents/MacOS/Orchestra",
        log,
        spawn,
      }),
    ).toBeNull();
    expect(log).toHaveBeenCalledWith("install progress: helper not started", { error: "ENOENT" });
  });

  it("closes on its own: a hard limit, a no-quit limit, and the relaunch from the same bundle", () => {
    expect(INSTALL_PROGRESS_MAX_SECONDS).toBeGreaterThan(60);
    expect(INSTALL_PROGRESS_QUIT_SECONDS).toBeLessThan(INSTALL_PROGRESS_MAX_SECONDS);
    expect(INSTALL_PROGRESS_JXA).toContain("runningApplications");
    expect(INSTALL_PROGRESS_JXA).toContain("bundleURL");
    expect(INSTALL_PROGRESS_JXA).toContain("setActivationPolicy(1)");
  });
});
