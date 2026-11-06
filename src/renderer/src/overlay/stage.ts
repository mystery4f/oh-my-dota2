/**
 * 阶段行文案：一次性反馈（录音中/已刷新/麦克风不可用）优先于主进程 hint，
 * hint 优先于配置态说明；正常锁定运行时整块消失——浮层是字幕，不是仪表盘。
 * 放在独立模块而非组件文件里：react-refresh 要求组件文件只导出组件。
 */

let setStageState: ((text: string | null) => void) | null = null
let stageTimer: ReturnType<typeof setTimeout> | null = null

/** 显示一条阶段反馈；holdMs 给了就到点自动消失，没给就留着直到下一条。 */
export function setStage(text: string | null, holdMs?: number): void {
  setStageState?.(text)
  if (stageTimer) clearTimeout(stageTimer)
  stageTimer = null
  if (text !== null && holdMs !== undefined) {
    stageTimer = setTimeout(() => setStageState?.(null), holdMs)
  }
}

/** App 挂载时接上 React 状态；卸载时断开。 */
export function bindStage(setter: ((text: string | null) => void) | null): void {
  setStageState = setter
  if (setter === null && stageTimer) {
    clearTimeout(stageTimer)
    stageTimer = null
  }
}
