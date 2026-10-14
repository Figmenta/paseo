import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import path from "node:path";

// Figmenta fork: on macOS "Install and restart" quits Orchestra and Squirrel's ShipIt swaps
// the bundle with no window of its own. Measured on 1.3.15 -> 1.3.16 (2026-10-13): about
// 35 s with nothing on screen, and a user who reopened Orchestra in the meantime made
// ShipIt abort ("App Still Running Error"). This panel covers that gap. It cannot be part
// of Orchestra itself: Orchestra has quit, and ShipIt refuses to install while an instance
// of the target app is running. So it is a JavaScript-for-Automation script run by the
// system's /usr/bin/osascript, detached from Orchestra. It closes when Orchestra is running
// again from the same bundle path, or when Orchestra never quits (no install happened). If
// Orchestra has not come back by the hard limit, it says so before closing.

export const OSASCRIPT_PATH = "/usr/bin/osascript";

/** Whole seconds the panel may stay up whatever happens. */
export const INSTALL_PROGRESS_MAX_SECONDS = 120;
/** Seconds to wait for the old Orchestra to quit before deciding no install is happening. */
export const INSTALL_PROGRESS_QUIT_SECONDS = 30;

// argv: version, bundle path, max seconds, quit seconds, [png snapshot path, tests only].
// Numbers are plain literals: JXA does not expose every Cocoa enum.
export const INSTALL_PROGRESS_JXA = String.raw`
ObjC.import("Cocoa");
function run(argv) {
  var version = argv[0] || "";
  var bundlePath = String(argv[1] || "").replace(/\/+$/, "");
  var maxSeconds = Number(argv[2]) || 120;
  var quitSeconds = Number(argv[3]) || 30;
  var snapshotPath = argv[4] || "";

  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: no Dock icon, no menu bar
  app.finishLaunching;

  var width = 380;
  var height = 128;
  var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, width, height), 1 /* titled */, 2 /* buffered */, false);
  panel.setTitle("Orchestra");
  panel.setLevel(3); // floating
  panel.setHidesOnDeactivate(false);
  panel.setReleasedWhenClosed(false);
  var content = panel.contentView;

  function label(text, y, size, bold) {
    var field = $.NSTextField.labelWithString(text);
    field.setFont(bold ? $.NSFont.boldSystemFontOfSize(size) : $.NSFont.systemFontOfSize(size));
    field.setFrame($.NSMakeRect(24, y, width - 48, size + 6));
    content.addSubview(field);
    return field;
  }
  var title = label("Updating Orchestra", height - 42, 15, true);
  var line1 = label("Orchestra " + version + " is being installed.", height - 66, 13, false);
  var line2 = label("It will reopen by itself, this takes up to a minute.", height - 86, 13, false);

  var bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(24, 18, width - 48, 12));
  bar.setStyle(0); // bar
  bar.setIndeterminate(true);
  bar.setUsesThreadedAnimation(true);
  content.addSubview(bar);

  panel.center;
  panel.makeKeyAndOrderFront(null);
  bar.startAnimation(null);
  app.activateIgnoringOtherApps(true);

  function orchestraRunning() {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (var i = 0; i < apps.count; i++) {
      var url = apps.objectAtIndex(i).bundleURL;
      if (url.isNil()) continue;
      if (String(ObjC.unwrap(url.path)).replace(/\/+$/, "") === bundlePath) return true;
    }
    return false;
  }

  function pump(seconds) {
    var until = $.NSDate.dateWithTimeIntervalSinceNow(seconds);
    while (true) {
      var event = app.nextEventMatchingMaskUntilDateInModeDequeue(
        $.NSEventMaskAny, until, $.NSDefaultRunLoopMode, true);
      if (event.isNil()) return;
      app.sendEvent(event);
    }
  }

  var started = Date.now();
  var quitAt = null;
  var back = false;
  var snapshotDone = false;
  while ((Date.now() - started) / 1000 < maxSeconds) {
    pump(0.25);
    if (snapshotPath && !snapshotDone) {
      var rect = content.bounds;
      var rep = content.bitmapImageRepForCachingDisplayInRect(rect);
      content.cacheDisplayInRectToBitmapImageRep(rect, rep);
      rep.representationUsingTypeProperties(4 /* PNG */, $()).writeToFileAtomically(snapshotPath, true);
      snapshotDone = true;
    }
    var running = orchestraRunning();
    if (quitAt === null) {
      if (!running) quitAt = Date.now();
      else if ((Date.now() - started) / 1000 > quitSeconds) break;
    } else if (running) {
      back = true;
      pump(1.5); // the new Orchestra puts up its splash
      break;
    }
  }
  if (quitAt !== null && !back) {
    // Orchestra quit but did not come back: say what to do instead of vanishing.
    bar.stopAnimation(null);
    bar.setHidden(true);
    title.setStringValue("Orchestra did not reopen");
    line1.setStringValue("Open Orchestra again from the Applications folder.");
    line2.setStringValue("");
    pump(20);
  }
  panel.orderOut(null);
  return "";
}
`;

/** Orchestra.app path from the main executable (…/Orchestra.app/Contents/MacOS/Orchestra). */
export function bundlePathFromExecutable(executablePath: string): string | null {
  const macOsDir = path.dirname(executablePath);
  const contents = path.dirname(macOsDir);
  const bundle = path.dirname(contents);
  if (path.basename(macOsDir) !== "MacOS" || path.basename(contents) !== "Contents") return null;
  if (!bundle.endsWith(".app")) return null;
  return bundle;
}

type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => {
  pid?: number;
  unref: () => void;
  on: (event: "error", listener: (error: Error) => void) => unknown;
};

/**
 * Puts the install progress panel on screen, detached from Orchestra so it outlives it.
 * Returns the helper's pid, or null when it could not start (the install goes on anyway).
 */
export function startMacInstallProgress(options: {
  version: string;
  executablePath: string;
  log: (message: string, details?: Record<string, unknown>) => void;
  spawn?: Spawn;
}): number | null {
  const bundlePath = bundlePathFromExecutable(options.executablePath);
  if (!bundlePath) {
    options.log("install progress: not inside an .app bundle", { exe: options.executablePath });
    return null;
  }
  const spawn = options.spawn ?? (nodeSpawn as unknown as Spawn);
  try {
    const child = spawn(
      OSASCRIPT_PATH,
      [
        "-l",
        "JavaScript",
        "-e",
        INSTALL_PROGRESS_JXA,
        options.version,
        bundlePath,
        String(INSTALL_PROGRESS_MAX_SECONDS),
        String(INSTALL_PROGRESS_QUIT_SECONDS),
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", (error) => {
      options.log("install progress: helper failed", { error: error.message });
    });
    child.unref();
    options.log("install progress: helper started", { pid: child.pid ?? null, bundlePath });
    return child.pid ?? null;
  } catch (error) {
    options.log("install progress: helper not started", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
