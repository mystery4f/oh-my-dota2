import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startGsi, stopGsi, type GsiPayload } from '../services/gsi'
import {
  createTally,
  flatten,
  summarize,
  tallyFrame,
  type PathInfo
} from '../services/gsi-dump-analysis'

/**
 * `--gsi-dump [秒数]`：把 Dota 2 推过来的每一帧摊开，回答「他到底回调了什么」。
 *
 * 不落全量 payload——一局几万帧，存下来没人看。这里按「字段路径」去重统计，
 * 每条给出类型、出现次数和一个示例值，等于一份由 Dota 自己写的接口文档。
 * 另外逐块统计出现率、把 `events[]` 按 `event_type` 归类，这样一局打完就能回答
 * 「是训练场还是真对局」「allplayers 到底给不给」「除了聊天还有什么事件」。
 * 跑之前先关掉 dev 应用：端口 32123 只有一份 cfg 指向它。
 */
const DEFAULT_SECONDS = 60
const MAX_SECONDS = 3600

function secondsFromArgv(): number {
  const index = process.argv.indexOf('--gsi-dump')
  const raw = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SECONDS
  return Math.min(Math.floor(raw), MAX_SECONDS)
}

export async function runGsiDumpProbe(): Promise<void> {
  const seconds = secondsFromArgv()
  const paths = new Map<string, PathInfo>()
  const tally = createTally()
  const states: string[] = []
  let firstAt: number | null = null
  let lastAt: number | null = null

  let status
  try {
    status = await startGsi({
      // 探针不碰 Dota 目录：cfg 早已由应用自身写好，这里只监听同一个端口。
      writeConfig: false,
      effects: {
        startCapture: () => undefined,
        stopCapture: () => true,
        rememberNickname: () => undefined,
        pushChat: () => undefined
      },
      onFrame: (payload: GsiPayload) => {
        const now = Date.now()
        if (firstAt === null) firstAt = now
        lastAt = now
        flatten(payload, '', paths)
        tallyFrame(tally, payload)
        const state = payload.map?.game_state
        if (state && states[states.length - 1] !== state) states.push(state)
      }
    })
  } catch (error) {
    console.log(
      'GSI_DUMP_RESULT',
      JSON.stringify({
        ok: false,
        error: '端口占用或启动失败：先关掉 dev 应用再跑',
        detail: error instanceof Error ? error.message : String(error)
      })
    )
    app.exit(1)
    return
  }

  console.log(
    'GSI_DUMP',
    JSON.stringify({ listening: status.listening, port: status.port, seconds, cfg: 'GSI 配置由应用书写，探针不覆盖' })
  )

  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000))
  stopGsi()

  const summary = summarize(tally)
  const inventory = [...paths.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, info]) => ({ path, type: info.type, hits: info.hits, sample: info.sample }))
  const result = {
    ok: summary.frames > 0,
    port: status.port,
    seconds,
    frames: summary.frames,
    spanMs: firstAt !== null && lastAt !== null ? lastAt - firstAt : 0,
    states,
    pathCount: inventory.length,
    file: ''
  }
  const file = join(app.getPath('userData'), 'logs', 'gsi-frames.json')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...result,
          // 报告本身也要落盘：下次判读不必再占端口重跑。
          blocks: summary.blocks,
          events: summary.events,
          matchIds: summary.matchIds,
          allplayersFrames: summary.allplayersFrames,
          verdict: summary.verdict,
          paths: inventory
        },
        null,
        2
      ),
      'utf8'
    )
    result.file = file
  } catch (error) {
    result.file = '写入失败: ' + (error instanceof Error ? error.message : String(error))
  }

  console.log('GSI_DUMP_RESULT', JSON.stringify(result))
  console.log('GSI_DUMP_VERDICT', summary.verdict)
  console.log('GSI_DUMP_BLOCKS', JSON.stringify(summary.blocks))
  console.log('GSI_DUMP_EVENTS', JSON.stringify(summary.events))
  console.log('GSI_DUMP_PATHS', JSON.stringify(inventory, null, 2))
  if (summary.frames === 0) {
    console.log('GSI_DUMP_HINT', '这 ' + seconds + ' 秒没收到任何帧：Dota 2 可能没开，或对局里没到推送时机。')
  }
  app.exit(result.ok ? 0 : 1)
}
