import { describe, expect, it } from "vitest";
import {
  buildWindowsRelaunchScript,
  needsRelaunchHelper,
  RELAUNCH_HELPER_TIMEOUT_SECONDS,
  windowsRelaunchCommand,
} from "./windows-relaunch.js";

const plan = {
  exePath: "C:\\Users\\o'brien\\AppData\\Local\\Programs\\Orchestra\\Orchestra.exe",
  parentPid: 4242,
  installerPath:
    "C:\\Users\\x\\AppData\\Local\\orchestra-desktop-updater\\pending\\Orchestra-Setup-1.0.3-x64.exe",
  targetVersion: "1.0.3",
};

function lines(script: string): string[] {
  return script.split("\n");
}

describe("buildWindowsRelaunchScript", () => {
  it("waits for Orchestra to exit, then for the installer and the new version, then starts the exe", () => {
    const script = lines(buildWindowsRelaunchScript(plan));
    const waitParent = script.findIndex((l) => l.includes("Get-Process -Id $parentPid"));
    const waitInstall = script.findIndex(
      (l) =>
        l.startsWith("while") &&
        l.includes("Test-InstallerRunning") &&
        l.includes("Test-TargetInstalled"),
    );
    const bailOut = script.findIndex((l) => l === "if (-not (Test-TargetInstalled)) { exit 2 }");
    const alreadyRunning = script.findIndex((l) => l === "if ($running) { exit 0 }");
    const start = script.findIndex((l) => l === "Start-Process -FilePath $exe");
    for (const index of [waitParent, waitInstall, bailOut, alreadyRunning, start]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(waitParent).toBeLessThan(waitInstall);
    expect(waitInstall).toBeLessThan(bailOut);
    expect(bailOut).toBeLessThan(alreadyRunning);
    expect(alreadyRunning).toBeLessThan(start);
  });

  it("never starts a second Orchestra from the same exe", () => {
    const script = buildWindowsRelaunchScript(plan);
    expect(script).toContain(
      "$running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe }",
    );
    expect(script).toContain("if ($running) { exit 0 }");
  });

  it("starts nothing if the new version never lands before the deadline", () => {
    const script = buildWindowsRelaunchScript(plan);
    expect(script).toContain(
      `$deadline = (Get-Date).AddSeconds(${RELAUNCH_HELPER_TIMEOUT_SECONDS})`,
    );
    expect(script).toContain("$v -eq $target -or $v.StartsWith($target + '.')");
    expect(script).toContain("if (-not (Test-TargetInstalled)) { exit 2 }");
  });

  it("quotes paths as PowerShell literals and carries pid, installer and version", () => {
    const script = buildWindowsRelaunchScript(plan);
    expect(script).toContain(
      "$exe = 'C:\\Users\\o''brien\\AppData\\Local\\Programs\\Orchestra\\Orchestra.exe'",
    );
    expect(script).toContain(`$installer = '${plan.installerPath}'`);
    expect(script).toContain("$target = '1.0.3'");
    expect(script).toContain("$parentPid = 4242");
    expect(buildWindowsRelaunchScript({ ...plan, installerPath: null })).toContain(
      "$installer = $null",
    );
  });
});

describe("windowsRelaunchCommand", () => {
  it("runs PowerShell hidden with the script encoded as UTF-16LE base64", () => {
    const { command, args } = windowsRelaunchCommand(plan);
    expect(command).toBe("powershell.exe");
    expect(args.slice(0, -1)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(
      buildWindowsRelaunchScript(plan),
    );
  });
});

describe("needsRelaunchHelper", () => {
  it("only on Windows", () => {
    expect(needsRelaunchHelper("win32")).toBe(true);
    expect(needsRelaunchHelper("darwin")).toBe(false);
    expect(needsRelaunchHelper("linux")).toBe(false);
  });
});
