; Custom NSIS hooks for BonziBuddy Reborn (included via nsis.include in electron-builder.yml).
;
; 'Start with Windows' calls Electron's app.setLoginItemSettings, which writes an HKCU
; CurrentVersion\Run value (and a matching Explorer\StartupApproved\Run value) named after the
; AppUserModelId. main.ts sets that to the appId, which electron-builder exposes as ${APP_ID}.
; The default uninstaller never touches these keys, so remove them here. Skipped during
; upgrades (the old version is uninstalled silently with --updated) so the setting survives.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
