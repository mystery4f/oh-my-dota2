import { captureHint } from '@shared/overlay-hint'
import { app } from 'electron'
import {
  KEEP_VISIBLE_PX,
  OVERLAY_MIN_WIDTH,
  MINI_HEIGHT,
  MINI_WIDTH,
  clampGeometry,
  miniGeometry,
  moveBy,
  resizeFromLeft,
  shouldIgnoreMouse,
  snapToEdges,
  SNAP_PX,
  resizeFromRight
} from '@shared/overlay-geometry'

const WORK = { x: 0, y: 0, width: 1920, height: 1040 }

interface Case {
  name: string
  ok: boolean
  detail: string
}

/**
 * 拖拽/缩放全是纯算术，但错了只会表现为「窗口跳到屏幕外」或「拉左边右边跟着跑」，
 * 在实机上要靠手感和运气才发现。这里把每条不变式钉死：
 * - 任何几何都收在工作区内，且至少留 KEEP_VISIBLE_PX 像素可以抓回来
 * - 拉右侧只改 width，x 不动
 * - 拉左侧只改 x 与 width，右边缘钉死
 * - 无论怎么拉，宽度不低于 OVERLAY_MIN_WIDTH
 */
export function runOverlayGeometryProbe(): void {
  const cases: Case[] = []

  const push = (name: string, ok: boolean, detail: string): void => {
    cases.push({ name, ok, detail })
  }

  const tiny = clampGeometry({ x: 100, y: 100, width: 10, height: 10 }, WORK)
  push(
    '小于最小尺寸被抬起',
    tiny.width === OVERLAY_MIN_WIDTH && tiny.height >= 120,
    JSON.stringify(tiny)
  )

  const offLeft = clampGeometry({ x: -5000, y: 100, width: 340, height: 400 }, WORK)
  push(
    '拖出左边界还能抓回来',
    offLeft.x === WORK.x - offLeft.width + KEEP_VISIBLE_PX,
    `x=${offLeft.x} 期望 ${WORK.x - offLeft.width + KEEP_VISIBLE_PX}`
  )

  const offRight = clampGeometry({ x: 9000, y: 100, width: 340, height: 400 }, WORK)
  push(
    '拖出右边界还能抓回来',
    offRight.x === WORK.x + WORK.width - KEEP_VISIBLE_PX,
    `x=${offRight.x}`
  )

  const base = { x: 400, y: 200, width: 340, height: 400 }
  const moved = moveBy(base, 120, -60, WORK)
  push(
    '拖动整体平移',
    moved.x === 520 && moved.y === 140 && moved.width === 340,
    JSON.stringify(moved)
  )

  const right = resizeFromRight(base, 90, WORK)
  push(
    '拉右把手：x 不动、宽变',
    right.x === 400 && right.width === 430,
    JSON.stringify(right)
  )

  const left = resizeFromLeft(base, 60, WORK)
  const rightEdgeKept = left.x + left.width === base.x + base.width
  push(
    '拉左把手：右边缘钉死',
    rightEdgeKept && left.width === 280 && left.x === 460,
    JSON.stringify(left)
  )

  const leftMin = resizeFromLeft({ x: 400, y: 200, width: 300, height: 400 }, 500, WORK)
  push(
    '拉左把手不会窄过下限',
    leftMin.width === OVERLAY_MIN_WIDTH && leftMin.x + leftMin.width === 700,
    JSON.stringify(leftMin)
  )

  const rightMax = resizeFromRight({ x: 1200, y: 100, width: 340, height: 300 }, 500, WORK)
  push(
    '拉右把手不会溢出右边界',
    rightMax.x + rightMax.width === WORK.width && rightMax.width === 720,
    JSON.stringify(rightMax)
  )

  // 已经贴右边界时宽度下限优先：宁可溢出一点，也不能把窗口压到看不见。
  const rightEdge = resizeFromRight({ x: 1840, y: 100, width: 340, height: 300 }, 500, WORK)
  push(
    '贴边时下限优先',
    rightEdge.width === OVERLAY_MIN_WIDTH,
    JSON.stringify(rightEdge)
  )

  // 收起成小图标：必须绕开 240x120 下限，且不能跑到工作区外——这两条都是「点不到就再也展不开」的致命项。
  const mini = miniGeometry({ x: 1800, y: 1200, width: 400, height: 300 }, WORK)
  push(
    '小图标保持最小尺寸且不出界',
    mini.width === MINI_WIDTH &&
      mini.height === MINI_HEIGHT &&
      mini.x === WORK.width - MINI_WIDTH &&
      mini.y === WORK.height - MINI_HEIGHT,
    JSON.stringify(mini)
  )

  const miniIn = miniGeometry({ x: 320, y: 240, width: 400, height: 300 }, WORK)
  push(
    '小图标留在原位不动',
    miniIn.x === 320 && miniIn.y === 240 && miniIn.width === MINI_WIDTH,
    JSON.stringify(miniIn)
  )

  const miniClamp = miniGeometry({ x: 1900, y: -40, width: 400, height: 300 }, WORK)
  push(
    '小图标纵向也不出界',
    miniClamp.x === WORK.width - MINI_WIDTH && miniClamp.y === WORK.y,
    JSON.stringify(miniClamp)
  )

  // 穿透规则被改错过两次（解锁拖不动 / 收起后误点），所以单独立断言：
  // 只有「锁定且不在回复」才穿透，收起不改变它。
  push('锁定就穿透', shouldIgnoreMouse(true, false) === true, 'locked=true')
  push('解锁不吃穿透', shouldIgnoreMouse(false, false) === false, 'locked=false')
  push('回复框打开必须可点', shouldIgnoreMouse(true, true) === false, 'locked+reply')

  // 贴边吸附：只在真正靠边时生效，不能把「想放中间」的位置拽走。
  const snapL = snapToEdges({ x: 6, y: 300, width: 400, height: 300 }, WORK)
  push('靠左边会吸附', snapL.x === WORK.x, JSON.stringify(snapL))
  const snapMid = snapToEdges({ x: 300, y: 300, width: 400, height: 300 }, WORK)
  push('离边远就不动', snapMid.x === 300 && snapMid.y === 300, JSON.stringify(snapMid))
  const snapGap = snapToEdges({ x: WORK.width - 400 - (SNAP_PX - 1), y: 40, width: 400, height: 300 }, WORK)
  push('靠右边会吸附', snapGap.x === WORK.width - 400, JSON.stringify(snapGap))

  // 「为什么没字」的提示：正常必须闭嘴，异常必须说清是哪一种。
  push(
    '正常时不显示提示',
    captureHint({ running: true, gsiLive: true, lastError: null }) === null,
    'normal'
  )
  push(
    'GSI 未进对局要提示',
    captureHint({ running: true, gsiLive: false, lastError: null })?.includes('对局') === true,
    'gsi'
  )
  push(
    '捕获暂停要提示',
    captureHint({ running: false, gsiLive: true, lastError: null })?.includes('暂停') === true,
    'stopped'
  )
  push(
    '错误优先于其他提示',
    captureHint({ running: true, gsiLive: true, lastError: 'boom' })?.includes('boom') === true,
    'error'
  )

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(
    `OVERLAY_GEOMETRY_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
  )
  app.exit(failed.length > 0 ? 1 : 0)
}
