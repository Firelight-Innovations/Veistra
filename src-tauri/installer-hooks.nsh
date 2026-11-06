; Explorer's "Open with Veistra", added on install and taken away on uninstall.
;
; Tauri's NSIS template calls these two macros if `bundle > windows > nsis >
; installerHooks` points at this file. Everything here is registry work: the
; shell reads these keys to decide what appears on a right-click, and Veistra
; itself does not have to be running for them to be there.
;
; HKCU rather than HKLM, and that is not a preference. `installMode` is
; `currentUser`, so the installer never asks for Administrator and has no write
; access to HKLM. Writing per-user also means the uninstall below can actually
; remove what it added, and that two accounts on one machine do not fight over
; one entry.
;
; Three keys, because Explorer asks three different questions:
;
;   Directory\shell              right-click a folder
;   Directory\Background\shell   right-click the empty space *inside* a folder
;   *\shell                      right-click any file
;
; The command differs in one character between them. `%1` is the item that was
; clicked; `%V` is the folder being viewed, which is the only thing that makes
; sense for a background click where nothing was selected. Getting these the
; wrong way round produces a menu entry that opens the wrong thing, silently.
;
; `$INSTDIR\${MAINBINARYNAME}.exe` is the installed binary. Both variables are
; defined by Tauri's template before it invokes these macros.

!macro NSIS_HOOK_POSTINSTALL
  ; --- Right-click a folder -------------------------------------------------
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithVeistra" "" "Open with Veistra"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithVeistra" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithVeistra\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; --- Right-click inside a folder, with nothing selected -------------------
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithVeistra" "" "Open with Veistra"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithVeistra" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithVeistra\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  ; --- Right-click a file ---------------------------------------------------
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithVeistra" "" "Open with Veistra"
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithVeistra" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithVeistra\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; --- veistra:// ----------------------------------------------------------
  ; veistra.com's "Open the Veistra app" links here. Windows runs the command
  ; with the URL as `%1`; `launch.rs` skips it as a path and raises the window,
  ; through single-instance when one is already open. `url_scheme.rs` writes the
  ; same keys for a build that was never installed.
  WriteRegStr HKCU "Software\Classes\veistra" "" "URL:Veistra"
  WriteRegStr HKCU "Software\Classes\veistra" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\veistra\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\veistra\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Explorer caches the verbs it has already read. Without this the entries do
  ; not appear until the next sign-in, which reads exactly like a broken
  ; installer to the person who just ran it.
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Delete the `command` subkey first: `DeleteRegKey` removes a key and its
  ; children, but doing the parents in this order leaves nothing behind if one
  ; of them is missing because a previous version did not write it.
  ;
  ; Every name the product has had, not only the current one. Only an
  ; uninstaller ever removes one of these keys, so a build that renamed itself
  ; and deleted only its own stem would leave the previous name in the registry
  ; forever, on a menu entry pointing at a binary that is no longer installed.
  ; The list has to match `SUPERSEDED_PRODUCTS` in `userdata/identity.rs`, and
  ; `scripts/check-identity.mjs` fails the build when it does not.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenWithVeistra"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenWithOpenKaava"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenWithHELVE"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenWithVeistra"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenWithOpenKaava"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenWithHELVE"
  DeleteRegKey HKCU "Software\Classes\*\shell\OpenWithVeistra"
  DeleteRegKey HKCU "Software\Classes\*\shell\OpenWithOpenKaava"
  DeleteRegKey HKCU "Software\Classes\*\shell\OpenWithHELVE"

  ; The URL scheme, named for the website rather than the product, so one key.
  DeleteRegKey HKCU "Software\Classes\veistra"

  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
