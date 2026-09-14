; ShapeDay installer hooks (auto-included by electron-builder).
;
; Update support: the app is tray-resident — closing its windows does NOT
; exit the process — so the stock "please close the application" gate would
; stall an in-place update. Kill it before that check runs. Safe: the store
; flushes after every user action (worst case ~150ms of debounced write).
; taskkill is a no-op on a fresh install (process not found) and under wine.

!macro customInit
  nsExec::Exec 'taskkill /IM ShapeDay.exe /F'
  Sleep 300
!macroend
