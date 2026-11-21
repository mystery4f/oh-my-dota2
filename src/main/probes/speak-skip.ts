/**
 * #164：朗读腿的静默路径必须落盘，而且四种理由要逐字写得回来。
 *
 * 探针走的是**真写入器**（`appendVoiceChainLine` → `logs/voice-chain.jsonl`），
 * 不是只看返回值：验收要回答的是「收工后翻得到那条行吗」，不是「纯函数算得对吗」。
 * 框架已把探针的 logs 目录指到临时根，这里再核一遍真实 logs/ 没被碰。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { exitProbe, guardProbe, probeCases } from './harness'
import { appendVoiceChainLine, voiceChainPath } from '../services/voice/chain-log'
import { logsDir } from '../services/logs/base-dir'
import {
  SPEAK_LOG_TEXT_MAX,
  shouldLogSkip,
  speakLogText,
  speakReasonLabel,
  speakSkipLine,
  type SpeakSkipReason
} from '@shared/speak-log'

const REASONS: readonly SpeakSkipReason[] = ['mute', 'own', 'muted-player', 'empty']

export async function runSpeakSkipProbe(): Promise<void> {
  guardProbe('SPEAK_SKIP_PROBE')
  const { cases, push } = probeCases()

  push('判据：null 不值得落盘', shouldLogSkip(null) === false)
  push('判据：五种理由都落盘', REASONS.every((reason) => shouldLogSkip(reason)))
  push('正文截断到 30 字并与控制台一致', speakLogText('x'.repeat(60)).length === SPEAK_LOG_TEXT_MAX)
  push('正文里的换行被压成单行', speakLogText('第一行\n第二行') === '第一行 第二行')
  push('reason 为 null 时宁可不写', speakSkipLine({ reason: null, own: false, text: 'x' }) === null)
  push(
    '五种理由各有一句中文（面板可读）',
    new Set(REASONS.map((reason) => speakReasonLabel(reason))).size === REASONS.length
  )

  const file = voiceChainPath()
  push('落盘目标就是 logs/voice-chain.jsonl（不新开文件）', file === join(logsDir(), 'voice-chain.jsonl'), file)
  push('落盘目录跟 logsDir() 走（探针不会写真实 logs）', file.startsWith(logsDir()), file)

  const before = existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0
  for (const reason of REASONS) {
    const line = speakSkipLine({ reason, own: reason === 'own', text: `${reason} 的那句原文`, stage: 'announce' })
    if (line !== null) appendVoiceChainLine(line)
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const rows = text
    .split('\n')
    .filter((one) => one.trim() !== '')
    .map((one) => {
      try {
        return JSON.parse(one) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((one): one is Record<string, unknown> => one !== null)
    .filter((one) => one['kind'] === 'speak-skip')

  push('四种理由各写了一行', rows.length === REASONS.length, `rows=${rows.length}`)
  push(
    'reason 逐字写得回来',
    REASONS.every((reason) => rows.some((row) => row['reason'] === reason)),
    rows.map((row) => String(row['reason'])).join(',')
  )
  push('own 字段与理由分开记（own 那条才为 true）', rows.filter((row) => row['own'] === true).length === 1)
  push('每行都带 kind / stage / at / text', rows.every((row) => row['kind'] === 'speak-skip' && row['stage'] === 'announce' && typeof row['at'] === 'string' && typeof row['text'] === 'string'))
  push('text 不超过 30 字', rows.every((row) => String(row['text']).length <= SPEAK_LOG_TEXT_MAX))
  push('写了四行（没有多写的空行/半行）', existsSync(file) && text.split('\n').length >= before + REASONS.length - 1)

  // 丢弃行：同一个文件、同一套形状，stage 说得出来源
  const dropLine = { at: new Date().toISOString(), kind: 'speak-drop', stage: 'announce', text: '顶掉那句' }
  appendVoiceChainLine(dropLine)
  const after = readFileSync(file, 'utf8')
  push('丢弃行也进同一个文件', after.includes('"kind":"speak-drop"'))

  // 隔离：探针的 logs 根是临时目录，不该是我们真实数据目录
  push('logs 根在临时目录（不在 userData 下）', logsDir().includes('omd2-probe-logs') || !logsDir().includes('oh-my-dota2'), logsDir())

  const failed = cases.filter((one) => !one.ok)
  for (const one of cases) console.log(`${one.ok ? 'PASS' : 'FAIL'} | ${one.name} | ${one.detail}`)
  console.log(
    `SPEAK_SKIP_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length, file })}`
  )
  exitProbe(failed.length === 0)
}

/** 给别处核对用：探针跑完后真实 logs 目录里该有的文件（不参与断言）。 */
export function describeLogsDir(): string[] {
  try {
    return readdirSync(logsDir())
  } catch {
    return []
  }
}