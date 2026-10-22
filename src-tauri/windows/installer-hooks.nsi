; Tauri NSIS installer hooks for desktop-pet
; (wired in via tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; WHY THIS FILE EXISTS
;   The agent bridge writes hook entries into the coding agent's own config file
;   (settings.json) pointing at this executable. NSIS removes files, registry keys
;   and shortcuts on uninstall but knows nothing about third-party config files, so
;   without this hook the entries survive and every later tool call tries to start
;   an exe that no longer exists. The cleanup itself lives in Rust
;   (src-tauri/src/services/agent/linkage.rs, CLI flag --pet-hook-cleanup);
;   this file only wires it into the uninstaller.
;
; ORDER THAT MATTERS
;   Tauri expands NSIS_HOOK_PREUNINSTALL as the first thing inside "Section Uninstall",
;   before CheckIfAppIsRunning and before any Delete. That is what lets us clean up
;   while the pet is still running and while our own exe is still on disk.
;
; UPDATE MODE
;   un.onInit parses /UPDATE into $UpdateMode. Tauri's own reinstall page can run the
;   OLD uninstaller while a new package is being installed, and cleaning up there would
;   strip the hooks on every upgrade: startup deliberately only removes entries and
;   never reinstalls them, so the bridge would stay silently dead afterwards. So we gate
;   on $UpdateMode exactly like the template does when it skips shortcut removal.
;
; NEVER ABORT ON FAILURE
;   The ExecWait exit code is printed and never branched on. A failed cleanup must not
;   block the uninstall -- that is the whole point of doing it here.

; Never define MAINBINARYNAME in this file: installer.nsi includes it (line 32) BEFORE its own
; unconditional define (line 48), so a fallback here collides -- ${MAINBINARYNAME} expands at !insertmacro time.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; Quotes around the path: $INSTDIR may contain spaces ("C:\Program Files\...").
    DetailPrint "desktop-pet: removing agent hook entries"
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --pet-hook-cleanup' $0
    DetailPrint "desktop-pet: hook cleanup exit code $0 (ignored by design)"
  ${Else}
    DetailPrint "desktop-pet: update mode, agent hooks are kept"
  ${EndIf}
!macroend
