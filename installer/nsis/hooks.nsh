; Tauri NSIS installer hooks — AgentDeck
;
; AgentDeck 的数据（会话元数据、日志、ui.sqlite 等）在 Tauri app_data_dir：
;   %APPDATA%\local.agentdeck.desktop          （见 docs/design.md 3.5 / 7.1）
; WebView2 用户数据在 %LOCALAPPDATA%\local.agentdeck.desktop。
; 它们由运行时创建，不在安装清单里，卸载器默认会保留。卸载时询问是否一并删除：
; 选「否」保留数据便于重装后继续使用，选「是」彻底清除。
; 静默卸载（含覆盖安装时自动执行的旧版卸载）不弹窗，默认保留数据。
; 用 ReadEnvStr 取当前用户的目录，不依赖 SetShellVarContext 的上下文。

!macro NSIS_HOOK_PREUNINSTALL
  Push $R0
  Push $R1
  IfSilent agentdeck_keep_userdata
  ReadEnvStr $R0 APPDATA
  ReadEnvStr $R1 LOCALAPPDATA
  StrCmp $R0 "" agentdeck_keep_userdata
  ; 只有真的存在数据时才询问。
  IfFileExists "$R0\local.agentdeck.desktop\*.*" 0 agentdeck_keep_userdata
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 AgentDeck 的个人数据（会话记录 / 设置 / 日志）？$\r$\n位置：$R0\local.agentdeck.desktop" /SD IDNO IDNO agentdeck_keep_userdata
    RMDir /r "$R0\local.agentdeck.desktop"
    StrCmp $R1 "" agentdeck_keep_userdata
    RMDir /r "$R1\local.agentdeck.desktop"
  agentdeck_keep_userdata:
  Pop $R1
  Pop $R0
!macroend
