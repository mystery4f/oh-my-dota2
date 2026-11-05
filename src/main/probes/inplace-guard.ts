import { app } from 'electron'
import {
  INPLACE_STALE_MS,
  decideInPlaceDelivery,
  inplaceFailureLine,
  pickInPlaceDraft
} from '@shared/inplace'
/**
 * 原地直发的纯决策回归（`--inplace-guard-probe`）：不碰游戏、不碰输入桥、不开窗。
 *
 * 直发最容易出的错不是「翻错」，而是「翻的是上一条」：读走之后过了很久才回来的译文
 * 被写进聊天框，回车一发就盖掉了用户新打的那句。这里把三道闸门钉死：
 * 草稿怎么选（pickInPlaceDraft）、译文要不要写回（decideInPlaceDelivery）、
 * 失败了怎么说给人听（inplaceFailureLine）。桥与流水线的物理行为走人工验收。
 */
interface Row {
  name: string
  ok: boolean
  detail: string
}

export async function runInPlaceGuardProbe(): Promise<void> {
  const cases: Row[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    cases.push({ name, ok, detail })
  }

  // 草稿选择：有内容就是新的；失败且聊天框真空时才认回上一句被读走的草稿。
  const fresh = pickInPlaceDraft({ ok: true, text: '  推中路  ' })
  push('读到内容就用它，并去掉首尾空白', fresh.kind === 'fresh' && fresh.draft === '推中路', JSON.stringify(fresh))
  const orphan = pickInPlaceDraft({ ok: false, code: 'NOCONTENT', orphan: '别送' })
  push(
    '聊天框空了、但还有被读走的草稿 → 复用那一句',
    orphan.kind === 'orphan' && orphan.draft === '别送',
    JSON.stringify(orphan)
  )
  const noOrphan = pickInPlaceDraft({ ok: false, code: 'NOCONTENT', orphan: null })
  push('聊天框空了又没有草稿 → 失败而不是空翻译', noOrphan.kind === 'fail' && noOrphan.reason.length > 0, JSON.stringify(noOrphan))
  const blank = pickInPlaceDraft({ ok: true, text: '   ' })
  push('只读到空白算空草稿', blank.kind === 'empty', JSON.stringify(blank))
  const otherFail = pickInPlaceDraft({ ok: false, code: 'NOFOCUS', error: '游戏不在前台', orphan: '别送' })
  push(
    '别的失败不拿草稿顶替（游戏不在前台不是「聊天框空了」）',
    otherFail.kind === 'fail' && otherFail.reason === '游戏不在前台',
    JSON.stringify(otherFail)
  )
  const bareFail = pickInPlaceDraft({ ok: false })
  push('失败但没有理由 → 也给一句人话', bareFail.kind === 'fail' && bareFail.reason.length > 0, JSON.stringify(bareFail))

  // 译文要不要写回：打断 > 空译文 > 过期 > 正常。
  const cancelled = decideInPlaceDelivery({ cancelled: true, line: 'push mid', elapsedMs: 500 })
  push('被打断就放弃，完全不碰聊天框', cancelled.action === 'abandon', JSON.stringify(cancelled))
  const staleAndEmpty = decideInPlaceDelivery({ cancelled: true, line: null, elapsedMs: INPLACE_STALE_MS + 1 })
  push('被打断优先于其他理由（不能回贴到用户正在打的框里）', staleAndEmpty.action === 'abandon', JSON.stringify(staleAndEmpty))
  const empty = decideInPlaceDelivery({ cancelled: false, line: null, elapsedMs: 900 })
  push('没翻出英文 → 回贴原文，不按回车', empty.action === 'restore', JSON.stringify(empty))
  const blankLine = decideInPlaceDelivery({ cancelled: false, line: '   ', elapsedMs: 900 })
  push('译文只有空白等同没翻出来', blankLine.action === 'restore', JSON.stringify(blankLine))
  const stale = decideInPlaceDelivery({ cancelled: false, line: 'push mid', elapsedMs: INPLACE_STALE_MS })
  push(
    `到手就过期（>${INPLACE_STALE_MS / 1000} 秒）→ 不写回、回贴原文`,
    stale.action === 'restore' && stale.reason.includes('晚'),
    JSON.stringify(stale)
  )
  const justInTime = decideInPlaceDelivery({ cancelled: false, line: 'push mid', elapsedMs: INPLACE_STALE_MS - 1 })
  push('刚好赶上（未到阈值）照常发出', justInTime.action === 'send', JSON.stringify(justInTime))
  const normal = decideInPlaceDelivery({ cancelled: false, line: 'push mid now', elapsedMs: 2_400 })
  push(
    '正常路径把译文原样发出去',
    normal.action === 'send' && normal.line === 'push mid now',
    JSON.stringify(normal)
  )

  // 失败怎么说给人听：救回来和没救回来是两回事，用户要据此决定要不要重打。
  const kept = inplaceFailureLine({ reason: '没有翻出可以发送的英文', restored: true })
  push('回贴成功要说「原文已放回聊天框」', kept.includes('原文已放回聊天框'), kept)
  const lost = inplaceFailureLine({ reason: '没有翻出可以发送的英文', restored: false })
  push('没救回来就不能说放回去了', !lost.includes('已放回'), lost)
  const prefix = inplaceFailureLine({ reason: '游戏不在前台', restored: false })
  push('失败文案统一带「直发失败」前缀，方便浮层一眼区分', prefix.startsWith('直发失败：'), prefix)
  const longReason = inplaceFailureLine({ reason: 'x'.repeat(200), restored: false })
  push('过长理由要截断，别把浮层撑爆', longReason.length < 80, `${longReason.length} 字`)

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(
    `INPLACE_GUARD_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
  )
  app.exit(failed.length > 0 ? 1 : 0)
}
