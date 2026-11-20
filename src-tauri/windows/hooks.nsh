; Notes Studio NS-1B: "Open with > Hivemind" for text files. Tauri's fileAssociations covers .md, .markdown, .hmdoc and
; .canvas; this registers the app itself, so Explorer offers it for other text types too. It never makes Hivemind the
; default program. SHCTX is HKCU for a per-user install (the default) and HKLM for a per-machine one.
; MultiSelectModel=Player asks Explorer to start one process for a multi-file selection (to verify on an installed
; build, spike S2 in docs/notes-studio/spikes/deferred.md).

!define HM_APPKEY "Software\Classes\Applications\${MAINBINARYNAME}.exe"

!macro HM_TYPE EXT
  WriteRegStr SHCTX "${HM_APPKEY}\SupportedTypes" "${EXT}" ""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${HM_APPKEY}" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${HM_APPKEY}\shell\open" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "${HM_APPKEY}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro HM_TYPE ".md"
  !insertmacro HM_TYPE ".markdown"
  !insertmacro HM_TYPE ".txt"
  !insertmacro HM_TYPE ".log"
  !insertmacro HM_TYPE ".json"
  !insertmacro HM_TYPE ".yaml"
  !insertmacro HM_TYPE ".yml"
  !insertmacro HM_TYPE ".toml"
  !insertmacro HM_TYPE ".ini"
  !insertmacro HM_TYPE ".cfg"
  !insertmacro HM_TYPE ".csv"
  !insertmacro HM_TYPE ".xml"
  !insertmacro HM_TYPE ".ps1"
  !insertmacro HM_TYPE ".py"
  !insertmacro HM_TYPE ".ts"
  !insertmacro HM_TYPE ".js"
  !insertmacro HM_TYPE ".rs"
  !insertmacro HM_TYPE ".sql"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "${HM_APPKEY}"
!macroend
