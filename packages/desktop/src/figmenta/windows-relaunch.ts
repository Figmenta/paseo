// Figmenta fork: relaunch after a Windows update, owned by Orchestra.
//
// electron-updater asks the NSIS installer to reopen the app (`--force-run`), and the
// installer does it with ExecShellAsUser on its shortcut. Measured on 2026-09-28 (a real PC
// and windows-latest CI): the update installs, Orchestra never comes back. So on Windows
// Orchestra no longer relies on it: right before quitAndInstall it starts a hidden,
// detached PowerShell helper that
//   1. waits for this Orchestra process to exit,
//   2. waits for the installer to finish and the installed exe to carry the new version,
//   3. starts the installed exe directly — unless an Orchestra from that exe is already
//      running (no double start),
// all under one deadline. The installer is then run WITHOUT --force-run, so the helper is
// the only relauncher. The helper inherits Orchestra's environment.
//
// Pure: builds the script and the command line; mandatory-update-electron.ts spawns it.

export const RELAUNCH_HELPER_TIMEOUT_SECONDS = 180;

export interface WindowsRelaunchPlan {
  /** Installed Orchestra.exe (process.execPath: the installer replaces it in place). */
  exePath: string;
  /** This Orchestra main process. */
  parentPid: number;
  /** The downloaded installer electron-updater is about to run, if known. */
  installerPath: string | null;
  /** Version the installed exe must report before it is started. */
  targetVersion: string;
  timeoutSeconds?: number;
}

/** PowerShell single-quoted literal: the only escape is '' for '. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsRelaunchScript(plan: WindowsRelaunchPlan): string {
  const timeout = plan.timeoutSeconds ?? RELAUNCH_HELPER_TIMEOUT_SECONDS;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${psLiteral(plan.exePath)}`,
    `$installer = ${plan.installerPath ? psLiteral(plan.installerPath) : "$null"}`,
    `$target = ${psLiteral(plan.targetVersion)}`,
    `$parentPid = ${Math.trunc(plan.parentPid)}`,
    `$deadline = (Get-Date).AddSeconds(${Math.trunc(timeout)})`,
    // 1. this Orchestra is gone
    "while ((Get-Process -Id $parentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }",
    // 2. the installer is done and the exe carries the target version
    "function Test-InstallerRunning { if (-not $installer) { return $false }; [bool](Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $installer }) }",
    "function Test-TargetInstalled { $v = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion; $v -and ($v -eq $target -or $v.StartsWith($target + '.')) }",
    "while (((Test-InstallerRunning) -or -not (Test-TargetInstalled)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }",
    "if (-not (Test-TargetInstalled)) { exit 2 }",
    // 3. start it, unless something already did
    "Start-Sleep -Seconds 2",
    "$running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe }",
    "if ($running) { exit 0 }",
    "Start-Process -FilePath $exe",
    "exit 0",
  ].join("\n");
}

/** Command line for the helper: hidden, no profile, script passed encoded (no quoting). */
export function windowsRelaunchCommand(plan: WindowsRelaunchPlan): {
  command: string;
  args: string[];
} {
  const encoded = Buffer.from(buildWindowsRelaunchScript(plan), "utf16le").toString("base64");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded,
    ],
  };
}

/** Only Windows needs it; macOS relaunches through Squirrel. */
export function needsRelaunchHelper(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}
