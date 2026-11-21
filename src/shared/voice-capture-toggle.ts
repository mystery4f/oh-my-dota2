/**
 * 面板「说话」按钮的返回（issue #165）。
 *
 * `sent` 说的是「这条命令真的发出去了吗」：主进程那条 500 ms 去抖是为热键自动重复设的，
 * 面板连点同样会被它挡回来。挡回来时必须说一句（`HELM_ACTION_BUSY`），
 * 否则按钮点了没反应——那正是所有「看着像坏了」的起点。
 */
export interface VoiceCaptureToggleResult {
  sent: boolean
}