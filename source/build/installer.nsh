!macro customUnInstall
  IfFileExists "$APPDATA\UFS Desktop Tracker\Local Tracker Data\*.*" 0 ufsNoTrackerData
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Delete this computer's local UFS Desktop Tracker data? This includes saved screenshots, session history, and pending company uploads. Choose No to keep that data on this computer." IDNO ufsKeepTrackerData
  RMDir /r "$APPDATA\UFS Desktop Tracker\Local Tracker Data"
  Goto ufsTrackerDataChoiceDone
  ufsKeepTrackerData:
  DetailPrint "Kept local UFS Desktop Tracker data in $APPDATA\UFS Desktop Tracker\Local Tracker Data"
  Goto ufsTrackerDataChoiceDone
  ufsNoTrackerData:
  DetailPrint "No local UFS Desktop Tracker data files were found."
  ufsTrackerDataChoiceDone:
!macroend
