!include "FileFunc.nsh"

; 数据目录在安装目录的同级（<安装目录名>-data），卸载器的 RMDir /r "$INSTDIR" 碰不到它。
; 所以这里只剩一件事：用户选「不保留」时把它删掉。标签名带前缀，避免和 electron-builder 内联脚本撞名。
!macro customUnInstall
  ${GetParent} "$INSTDIR" $R8
  ${GetFileName} "$INSTDIR" $R9
  StrCpy $R7 "$R8\$R9-data"
  ${IfNot} ${isUpdated}
    ${If} ${Silent}
      DetailPrint "Keeping user data in $R7"
      Goto omd_un_done
    ${EndIf}
    MessageBox MB_YESNO "是否保留配置与翻译记忆？|数据目录：$R7" /SD IDYES IDNO omd_un_wipe
    DetailPrint "Keeping user data in $R7"
    Goto omd_un_done
    omd_un_wipe:
    RMDir /r "$R7"
    omd_un_done:
  ${EndIf}
!macroend
