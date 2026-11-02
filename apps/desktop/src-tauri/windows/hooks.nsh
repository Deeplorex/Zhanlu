; Tauri registers file associations with the executable icon by default.
; Give PDF documents their own icon without changing the app or OFD icon.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Zhanlu.PDF\DefaultIcon" "" '$\"$INSTDIR\icons\pdf-document.ico$\",0'
  !insertmacro UPDATEFILEASSOC
!macroend
