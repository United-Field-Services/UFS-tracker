!macro customUnInstall
  ; An in-place update (electron-updater runs the new installer, which runs this uninstaller with --updated) must
  ; never ask about or delete the employee's local data. Silent uninstalls (/S) keep it too (/SD IDNO).
  ${ifNot} ${isUpdated}
    IfFileExists "$APPDATA\UFS Desktop Tracker\Local Tracker Data\*.*" 0 ufsNoTrackerData
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Delete this computer's local UFS Desktop Tracker data? This includes saved screenshots, session history, and pending company uploads. Choose No to keep that data on this computer." /SD IDNO IDNO ufsKeepTrackerData
    RMDir /r "$APPDATA\UFS Desktop Tracker\Local Tracker Data"
    Goto ufsTrackerDataChoiceDone
    ufsKeepTrackerData:
    DetailPrint "Kept local UFS Desktop Tracker data in $APPDATA\UFS Desktop Tracker\Local Tracker Data"
    Goto ufsTrackerDataChoiceDone
    ufsNoTrackerData:
    DetailPrint "No local UFS Desktop Tracker data files were found."
    ufsTrackerDataChoiceDone:
  ${endIf}
!macroend
