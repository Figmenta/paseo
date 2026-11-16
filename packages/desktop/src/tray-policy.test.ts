import { describe, expect, it } from "vitest";

import { shouldHideOnClose, trayIconFileName, usesTray } from "./tray-policy.js";

// Contratto-1321 §4.4: on Windows and Linux the main window hides instead of closing, except
// while the app quits (before-quit, before-quit-for-update); macOS is unchanged.
describe("shouldHideOnClose", () => {
  it.each([
    ["win32", false, true],
    ["win32", true, false],
    ["linux", false, true],
    ["linux", true, false],
    ["darwin", false, false],
    ["darwin", true, false],
    ["freebsd", false, false],
  ] as const)("platform %s, appQuitting %s → hide %s", (platform, appQuitting, hide) => {
    expect(shouldHideOnClose({ platform, appQuitting, isMainWindow: true })).toBe(hide);
  });

  it("never hides a window that is not the main one", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      for (const appQuitting of [false, true]) {
        expect(shouldHideOnClose({ platform, appQuitting, isMainWindow: false })).toBe(false);
      }
    }
  });
});

describe("usesTray and trayIconFileName", () => {
  it("puts Orchestra in the system tray on Windows and Linux only", () => {
    expect(usesTray("win32")).toBe(true);
    expect(usesTray("linux")).toBe(true);
    expect(usesTray("darwin")).toBe(false);
  });

  it("names the icon electron-builder copies into the resources folder", () => {
    expect(trayIconFileName("win32")).toBe("icon.ico");
    expect(trayIconFileName("linux")).toBe("32x32.png");
    expect(trayIconFileName("darwin")).toBeNull();
  });
});
