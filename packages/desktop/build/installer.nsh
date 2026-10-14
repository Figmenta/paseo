; Figmenta fork: "Install and restart" is never silent. Orchestra runs the installer with
; `--updated --force-run` (electron-updater), and up to 1.3.16 also with `/S`: the screen
; stayed empty for ~30 s until the relaunch, and users thought Orchestra was broken. Here
; the NEW installer turns its own progress window back on, so even the update started by
; an older, silent Orchestra shows it. Only together with --force-run: the install that
; electron-updater runs when the user QUITS with an update downloaded (`--updated /S`, no
; --force-run) must stay silent, not hold up logoff and not reopen Orchestra. A manual `/S`
; (IT deployments, the e2e) stays silent too. SetSilent is only allowed in .onInit, where
; electron-builder expands customInit.
!macro customInit
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
    SetSilent normal
  ${endIf}
!macroend

; Figmenta fork: during an update Orchestra has just quit, but processes started from its
; folder (the engine, its workers, the bundled Git and shells) can take seconds to go away
; or be started again by the engine while it stops. electron-builder's own check gives up
; after two rounds (~6 s): silent, the install was abandoned without a word; with the
; progress window on, the user got "Orchestra cannot be closed" and a Retry button (e2e
; 2026-10-14). So, for an update only, every process running from the install folder is
; stopped again and again until none is left for two checks in a row, for up to 20 s; then
; electron-builder's check runs as before (same folder rule, same message if it still
; fails). $$ is a literal $ for PowerShell.
; Defining customCheckAppRunning makes electron-builder skip these two (allowOnlyOneInstaller
; Instance.nsh), and its own check below needs them.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  ${if} ${isUpdated}
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$end = (Get-Date).AddSeconds(20); $$clear = 0; while ((Get-Date) -lt $$end -and $$clear -lt 2) { $$p = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }); if ($$p.Count -eq 0) { $$clear++ } else { $$clear = 0; $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 500 }"`
    Pop $0
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
