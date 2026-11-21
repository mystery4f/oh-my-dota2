import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishProbe, probeCases } from './harness'
import {
  GSI_READ_PATHS,
  PATCH_WATCH_MIN_FRAMES,
  collectFramePaths,
  glossaryHasHero,
  heroKey,
  judgePatchWatch,
  patchGapKey,
  patchWatchLine,
  unseenGaps,
  type PatchGap
} from '@shared/patch-watch'
import { flushPatchWatch, noteFrame, patchWatchPathsForProbe, resetPatchWatchForProbe } from '../services/patch-watch'
import { setLogsDirForProbe } from '../services/logs/base-dir'

/** 词表里的英雄展示名（探针自己给，避免依赖词表内容的当前形状）。 */
const GLOSSARY_HEROES = ['Shadow Fiend', 'Storm Spirit', 'Anti-Mage', 'Mirana', 'Tiny', 'Doom']

/** 一帧健康 payload：只带我们声明过的路径。 */
function healthyFrame(): Record<string, unknown> {
  return {
    provider: { name: 'Dota 2', appid: 570 },
    map: { name: 'start', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '123', game_time: 600 },
    player: { name: 'me', team_name: 'radiant', player_slot: 0, team_slot: 1, steamid: '1' },
    hero: { id: 11, name: 'npc_dota_hero_nevermore' },
    events: [{ event_type: 'chat_message', player_id: 0, channel_type: 12, message: 'gg', game_time: 601 }],
    allplayers: {
      '0': { name: 'me', team: 2, hero: 'npc_dota_hero_nevermore', hero_id: 11 },
      '1': { name: 'mate', team: 2, hero: 'npc_dota_hero_storm_spirit', hero_id: 17 }
    }
  }
}

function sampleOf(frames: Record<string, unknown>[], extra: { heroes?: string[]; eventTypes?: string[] } = {}) {
  const paths = new Set<string>()
  const heroes = new Set<string>(extra.heroes ?? [])
  const eventTypes = new Set<string>(extra.eventTypes ?? [])
  for (const frame of frames) {
    for (const path of collectFramePaths(frame)) paths.add(path)
    for (const info of Object.values((frame.allplayers ?? {}) as Record<string, { hero?: string }>)) {
      if (info?.hero) heroes.add(heroKey(info.hero))
    }
    const own = (frame.hero as { name?: string } | undefined)?.name
    if (own) heroes.add(heroKey(own))
    for (const event of (frame.events ?? []) as Array<{ event_type?: string }>) {
      if (event?.event_type) eventTypes.add(event.event_type)
    }
  }
  return { paths: [...paths], heroes: [...heroes], eventTypes: [...eventTypes], frames: frames.length }
}

/**
 * 补丁巡检（#131）的验收探针。
 *
 * 票面三条，逐条对应：
 * - 三种比对各自在对的时候报、不对的时候不报：字段 unread / 字段 missing / 词表缺英雄 / 事件类型；
 * - 健康安装什么都不写：健康帧走完服务层，jsonl 连文件都不存在；
 * - 日志行直呼其名：命名字段或英雄，绝不只写一个「不匹配」；面板那一行最多一句。
 */
export async function runPatchWatchProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const dir = mkdtempSync(join(tmpdir(), 'patch-watch-'))

  try {
    setLogsDirForProbe(dir)
    resetPatchWatchForProbe()

    // —— 健康帧：一条缺口都没有 ——
    const healthy = sampleOf(Array.from({ length: PATCH_WATCH_MIN_FRAMES }, healthyFrame))
    const none = judgePatchWatch(healthy, GLOSSARY_HEROES)
    push('健康帧一条缺口都不报', none.length === 0, JSON.stringify(none.map((gap) => gap.name)))

    // —— 比对一：没读过的字段 ——
    const unknownField = healthyFrame()
    ;(unknownField.map as Record<string, unknown>).clock_time = 601
    const unreadOnly = judgePatchWatch(sampleOf([unknownField]), GLOSSARY_HEROES)
    push(
      '多出来的字段被点名（且只点这一个）',
      unreadOnly.length === 1 && unreadOnly[0].kind === 'field-unread' && unreadOnly[0].name === 'map.clock_time',
      JSON.stringify(unreadOnly.map((gap) => `${gap.kind}:${gap.name}`))
    )
    push(
      '缺口详情直呼其名，不写「不匹配」',
      unreadOnly[0].detail.includes('map.clock_time') && !/不匹配|mismatch/i.test(unreadOnly[0].detail),
      unreadOnly[0].detail
    )

    // —— 比对二：声明要读却一次都没到 ——
    const few = sampleOf([healthyFrame(), healthyFrame()])
    push(
      `不到 ${PATCH_WATCH_MIN_FRAMES} 帧不判 missing`,
      judgePatchWatch(few, GLOSSARY_HEROES).every((gap) => gap.kind !== 'field-missing'),
      `frames=${few.frames}`
    )
    // 必推字段缺一个：steamid 摘掉，期望只报它一条（optional 的 draft / roshan / win_team 不报）。
  const withoutSteam = healthyFrame()
  delete (withoutSteam.player as Record<string, unknown>).steamid
  const enough = sampleOf(Array.from({ length: PATCH_WATCH_MIN_FRAMES }, () => withoutSteam))
    const missing = judgePatchWatch(enough, GLOSSARY_HEROES).filter((gap) => gap.kind === 'field-missing')
    push(
      `满 ${PATCH_WATCH_MIN_FRAMES} 帧后漏掉的必推字段被点名（且只点它）`,
      missing.length === 1 && missing[0].name === 'player.steamid',
      JSON.stringify(missing.map((gap) => gap.name))
    )

    // —— 比对三：词表缺英雄 ——
    push(
      '词表缺的英雄被点名（muerta 不在表里）',
      (() => {
        const gaps = judgePatchWatch({ ...healthy, heroes: ['muerta'] }, GLOSSARY_HEROES)
        return gaps.length === 1 && gaps[0].kind === 'hero' && gaps[0].name === 'muerta'
      })(),
      JSON.stringify(judgePatchWatch({ ...healthy, heroes: ['muerta'] }, GLOSSARY_HEROES).map((gap) => gap.name))
    )
    push(
      'id 与展示名不同形的英雄不算缺口（nevermore / obsidian_destroyer / windrunner）',
      ['nevermore', 'obsidian_destroyer', 'windrunner'].every((hero) =>
        glossaryHasHero(hero, [...GLOSSARY_HEROES, 'Outworld Destroyer', 'Windranger'])
      ),
      'expect alias hit'
    )
    push(
      '归一化把 Anti-Mage / antimage / anti_mage 当同一个',
      heroKey('Anti-Mage') === heroKey('npc_dota_hero_anti_mage') && heroKey('anti_mage') === 'antimage',
      heroKey('Anti-Mage')
    )

    // —— 比对四：没有分支处理的事件类型 ——
    push(
      '新事件类型被点名（chat_message 不报）',
      (() => {
        const gaps = judgePatchWatch({ ...healthy, eventTypes: ['chat_message', 'hero_pick'] }, GLOSSARY_HEROES)
        return gaps.length === 1 && gaps[0].kind === 'event-type' && gaps[0].name === 'hero_pick'
      })(),
      JSON.stringify(judgePatchWatch({ ...healthy, eventTypes: ['chat_message', 'hero_pick'] }, GLOSSARY_HEROES))
    )

    // —— 去重与文案 ——
    const gaps: PatchGap[] = unreadOnly
    push(
      '记过的缺口不再报（seen 去重）',
      unseenGaps(gaps, gaps.map(patchGapKey)).length === 0 && unseenGaps(gaps, []).length === 1,
      patchGapKey(gaps[0])
    )
    push(
      '面板那行最多一句、点名不多于三个',
      patchWatchLine([
        { kind: 'field-unread', name: 'a', detail: '' },
        { kind: 'hero', name: 'b', detail: '' },
        { kind: 'event-type', name: 'c', detail: '' },
        { kind: 'hero', name: 'd', detail: '' }
      ]) === '游戏里出现了我们还不认识的：a、b、c 等 4 项' && patchWatchLine([]) === '和游戏对得上',
      patchWatchLine(gaps)
    )

    // —— 服务层：健康安装什么都不写 ——
    const paths = patchWatchPathsForProbe()
    for (let i = 0; i < PATCH_WATCH_MIN_FRAMES; i += 1) noteFrame(healthyFrame())
    const healthyFresh = flushPatchWatch()
    push('健康帧落盘也是空的：日志文件根本没被创建', healthyFresh.length === 0 && !existsSync(paths.record), paths.record)

    // —— 服务层：有缺口时写一行，第二遍不重复写 ——
    resetPatchWatchForProbe()
    const dirty = healthyFrame()
    ;(dirty.map as Record<string, unknown>).clock_time = 601
    ;(dirty.allplayers as Record<string, { hero?: string }>)['7'] = { hero: 'npc_dota_hero_muerta' }
    for (let i = 0; i < PATCH_WATCH_MIN_FRAMES; i += 1) noteFrame(dirty)
    // 窗口满的那一帧 noteFrame 自己就判过并落盘了，这里读文件而不是读返回值。
    const written = existsSync(paths.record) ? readFileSync(paths.record, 'utf8').trim().split('\n') : []
    const parsed = written.length > 0 ? (JSON.parse(written[written.length - 1]) as { gaps: PatchGap[]; frames: number }) : null
    push(
      '有缺口时落一行，行里两个缺口都在（map.clock_time / muerta）',
      parsed !== null && parsed.gaps.some((gap) => gap.name === 'map.clock_time') && parsed.gaps.some((gap) => gap.name === 'muerta'),
      parsed ? JSON.stringify(parsed.gaps.map((gap) => gap.name)) : '没有落盘'
    )
    const explicit = flushPatchWatch()
    push('显式 flush 不重复写已记过的缺口', explicit.length === 0, `fresh=${explicit.length}`)
    const again = flushPatchWatch()
    const linesAfter = existsSync(paths.record) ? readFileSync(paths.record, 'utf8').trim().split('\n').length : 0
    push('同一批缺口再判一次不重复落盘', again.length === 0 && linesAfter === written.length, `lines=${linesAfter}`)

    // —— 声明表本身：GSI 的块一个都不缺 ——
    push(
      '声明表覆盖 payload 的每个块（provider/map/player/events/allplayers/hero/draft/roshan）',
      ['provider', 'map', 'player', 'events', 'allplayers', 'hero', 'draft', 'roshan'].every((block) =>
        GSI_READ_PATHS.some((path) => path === block || path.startsWith(`${block}.`) || path.startsWith(`${block}[]`))
      ),
      `${GSI_READ_PATHS.length} 条`
    )
  } finally {
    setLogsDirForProbe(null)
    rmSync(dir, { recursive: true, force: true })
  }
  finishProbe('PATCH_WATCH_PROBE', cases)
}