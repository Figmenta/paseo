// Figmenta fork (contratto-1321 §4.4): Orchestra in the system tray on Windows and Linux.
// Closing the main window there only hides it (tray-policy.ts); the tray brings it back and
// is the way to quit for real. macOS has no tray: the Dock does this job, unchanged.
import path from "node:path";
import { existsSync } from "node:fs";
import log from "electron-log/main";
import { Menu, Tray, nativeImage } from "electron";

import { trayIconFileName, usesTray } from "./tray-policy.js";

export interface OrchestraTrayDeps {
  /** Show and focus the main window (restoring it if minimized). */
  openOrchestra(): void;
  /** A real quit: the quit lifecycle stops our engine. */
  quit(): void;
}

let tray: Tray | null = null;

/** Create the tray once, at `ready`. A no-op on macOS, or when the icon is missing. */
export function createOrchestraTray(deps: OrchestraTrayDeps): Tray | null {
  if (tray !== null || !usesTray(process.platform)) return tray;
  const fileName = trayIconFileName(process.platform);
  if (fileName === null) return null;
  const iconPath = path.join(process.resourcesPath, fileName);
  if (!existsSync(iconPath)) {
    log.warn("[tray] icon not found, no tray", { iconPath });
    return null;
  }
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Orchestra");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Orchestra", click: () => deps.openOrchestra() },
      { type: "separator" },
      { label: "Quit Orchestra", click: () => deps.quit() },
    ]),
  );
  // Windows: a click on the icon is "Open Orchestra"; the menu stays on the right click.
  if (process.platform === "win32") {
    tray.on("click", () => deps.openOrchestra());
  }
  log.info("[tray] created", { iconPath });
  return tray;
}
