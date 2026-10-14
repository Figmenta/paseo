; Figmenta fork: the update install is never silent. Orchestra hands the installer
; `--updated` (electron-updater), and up to 1.3.16 also `/S`: the screen stayed empty for
; ~30 s between "Install and restart" and the relaunch, and users thought Orchestra was
; broken. Here the NEW installer turns its own progress window back on, so even the update
; started by an older, silent Orchestra shows it. A manual `/S` without `--updated` (IT
; deployments, the e2e) stays silent. SetSilent is only allowed in .onInit, where
; electron-builder expands customInit.
!macro customInit
  ${if} ${isUpdated}
    SetSilent normal
  ${endIf}
!macroend
