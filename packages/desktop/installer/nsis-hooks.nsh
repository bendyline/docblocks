; DocBlocks NSIS Installer Hooks
;
; The installer itself is plain — nothing to do at install time beyond
; what electron-builder handles (shortcuts, start-menu, file associations).
;
; On uninstall we offer to delete the small amount of app state we keep
; in %APPDATA%/DocBlocks (settings.json, window-state.json). The user's
; actual documents live in ~/Documents/DocBlocks (or wherever they
; configured) and are NEVER touched — those belong to the user.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove DocBlocks settings and window state from $APPDATA\DocBlocks?$\n$\nYour documents in Documents\DocBlocks will NOT be deleted." IDNO skip_user_data
    RMDir /r "$APPDATA\DocBlocks"
    DetailPrint "Removed DocBlocks app data from $APPDATA\DocBlocks"
  skip_user_data:
!macroend
