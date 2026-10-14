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
