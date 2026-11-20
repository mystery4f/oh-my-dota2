/**
 * 对局播报探针（#123）——不开游戏、不出声，用合成帧钉四条验收线。
 *
 * 锁的是「播报什么时候该响」这一件事：
 * - 每个触发每次机会恰好报一次，不重复：智慧符按序号、堆野/拉野按分钟、肉山按每局每死一次；
 * - 被切掉的触发不出声也不落日志（日志里有、耳朵没听到会被当成 bug 查）；
 * - 总闸关着时语音管线一次都不碰——这里用计数器代替管线，所以「零调用」是可断言的；
 * - 每行日志都带触发 id 和造成它的帧时间，排查不用猜是第几分钟报的。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_ANNOUNCE_TRIGGERS,
  initialAnnounceState,
  stepAnnounces,
  type DotaAnnounceFrame,
  type DotaAnnounceState
} from '@shared/dota-announce'
import { feedAnnouncement, logAnnouncement, type FeedAnnounceOptions } from '../services/voice/announce'
import { setLogsDirForProbe } from '../services/logs/base-dir'
import { finishProbe, probeCases } from './harness'

const framesAt = (state: DotaAnnounceState, seconds: number[]): ReturnType<typeof stepAnnounces>[] =>
  seconds.map((s) => stepAnnounces(state, { gameTime: s, matchId: '42' }))

const all = (patch: Partial<FeedAnnounceOptions> = {}): FeedAnnounceOptions => ({
  total: true,
  per: { ...DEFAULT_ANNOUNCE_TRIGGERS },
  speak: () => undefined,
  log: () => undefined,
  ...patch
})

export async function runAnnounceProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 智慧符：7:00 起每 7 分钟一次，序号法不漏不重
  {
    const state = initialAnnounceState()
    const out = framesAt(state, [419, 420, 420, 421, 500, 839, 840])
    const hits = out.flat().filter((e) => e.id === 'wisdom')
    push('智慧符 7:00 准点响一次', out[1].some((e) => e.id === 'wisdom') && out[1][0].gameTime === 420)
    push('同一秒的重复帧不重复响', out[2].length === 0)
    push('窗口外的帧不响（421/500/839）', [out[3], out[4], out[5]].every((list) => list.length === 0))
    push('第二枚智慧符 14:00 再响一次（恰好两次）', hits.length === 2 && hits[1].gameTime === 840)
  }

  // —— 堆野 :53-:55 与拉野 :15/:45：每分钟各一次
  {
    const state = initialAnnounceState()
    const out = framesAt(state, [172, 233, 234, 235, 236, 293, 375, 376, 405])
    const stack = out.flat().filter((e) => e.id === 'stack')
    const pull = out.flat().filter((e) => e.id === 'pull')
    push('堆野窗口 :53 响一次', out[1].some((e) => e.id === 'stack') && stack[0].gameTime === 233)
    push('窗口内的帧 234/235 不重复响', out[2].length === 0 && out[3].length === 0)
    push('下一分钟的 :53 再响一次（恰好两次）', stack.length === 2 && stack[1].gameTime === 293)
    push('拉野 :15 响一次', out[6].some((e) => e.id === 'pull') && pull[0].gameTime === 375)
    push('同一分钟的 :45 也要响（两个时刻不是一个记忆格）', out[8].some((e) => e.id === 'pull') && pull.length === 2)
  }

  // —— 肉山：roshan 块给出生死时间才报，8 分钟窗口起点一句，每局每死一次
  {
    const state = initialAnnounceState()
    const dead = (gameTime: number, deathAt: number, matchId = '42'): DotaAnnounceFrame => ({
      gameTime,
      matchId,
      roshan: { state: 'dead', death_time: deathAt }
    })
    const roshOf = (list: ReturnType<typeof stepAnnounces>): boolean => list.some((e) => e.id === 'rosh')
    push('肉山活着 / 没有 roshan 块时不响', !roshOf(stepAnnounces(state, { gameTime: 600, matchId: '42' })))
    push('刚死 10 秒不响（窗口没到）', !roshOf(stepAnnounces(state, dead(610, 600))))
    push('窗口前 1 秒仍不响', !roshOf(stepAnnounces(state, dead(1079, 600))))
    const open = stepAnnounces(state, dead(1080, 600)).filter((e) => e.id === 'rosh')
    push('窗口起点 8 分钟准点响一次', open.length === 1 && open[0].gameTime === 1080)
    push('窗口内后续帧不重复响', !roshOf(stepAnnounces(state, dead(1200, 600))))
    const revived = stepAnnounces(state, { gameTime: 1300, matchId: '42', roshan: { state: 'alive' } })
    push('肉山复活后状态清掉（这一死算过去了）', !roshOf(revived) && state.roshFired === false)
    const again = stepAnnounces(state, dead(2280, 1800)).filter((e) => e.id === 'rosh')
    push('第二次死亡 8 分钟后再响（每死一次各一次）', again.length === 1)
    push('第二次死亡的窗口内不重复响', !roshOf(stepAnnounces(state, dead(2400, 1800))))
    const nextMatch = stepAnnounces(state, dead(2900, 2400, 'next')).filter((e) => e.id === 'rosh')
    push('换局后新的一次死亡照样只报一次', nextMatch.length === 1)
    push('换局后同一次死亡不再补报', !roshOf(stepAnnounces(state, dead(3000, 2400, 'next'))))
  }

  // —— 被切掉的触发：不出声、不落日志
  {
    const speak: string[] = []
    const logged: string[] = []
    const state = initialAnnounceState()
    const out = feedAnnouncement(
      { gameTime: 233, matchId: '42' },
      state,
      all({ per: { ...DEFAULT_ANNOUNCE_TRIGGERS, stack: false }, speak: (e) => speak.push(e.id), log: (e) => logged.push(e.id) })
    )
    push('切掉堆野后同一帧堆野不出声', out.some((e) => e.id === 'stack') && !speak.includes('stack'))
    push('切掉的触发也不落日志（日志里不该有它）', !logged.includes('stack'))
    push('其它触发照常（切一条不影响另一条）', logged.length === speak.length)
  }

  // —— 总闸关：管线零调用
  {
    let calls = 0
    const state = initialAnnounceState()
    const out = feedAnnouncement(
      { gameTime: 420, matchId: '42' },
      state,
      all({ total: false, speak: () => (calls += 1), log: () => (calls += 1) })
    )
    push('总闸关着时事件数组为空', out.length === 0)
    push('总闸关着时语音管线与日志零调用（验收第三行）', calls === 0)
    push('总闸关着时状态也没被推进（打开开关不补报旧窗口）', state.wisdomIndex === -1)
  }

  // —— 日志：触发 id + 造成它的帧时间
  {
    const dir = mkdtempSync(join(tmpdir(), 'announce-probe-'))
    setLogsDirForProbe(dir)
    try {
      logAnnouncement({ id: 'wisdom', gameTime: 420, text: '智慧符刷新了' }, Date.UTC(2026, 0, 1, 0, 12, 0, 0))
      const raw = readFileSync(join(dir, 'announce.jsonl'), 'utf8').trim()
      const line = JSON.parse(raw) as { at: string; id: string; gameTime: number; text: string }
      push('日志行带触发 id', line.id === 'wisdom')
      push('日志行带造成它的帧时间（游戏时钟秒）', line.gameTime === 420)
      push('日志行带落盘时刻与念的文案', line.at.startsWith('2026-01-01') && line.text === '智慧符刷新了')
    } finally {
      setLogsDirForProbe(null)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // —— 帧里没有事实就不报（Aegis / 买活不做，见 pure 缝文件头的理由）
  {
    const events = [
      stepAnnounces(initialAnnounceState(), { gameTime: null, matchId: null }),
      stepAnnounces(initialAnnounceState(), { gameTime: Number.NaN, matchId: '42' }),
      stepAnnounces(initialAnnounceState(), { gameTime: -1, matchId: '42' })
    ]
    push('没有游戏时钟的帧什么都不报', events.every((list) => list.length === 0))
  }

  finishProbe('ANNOUNCE_PROBE', cases)
}