import { judgeCapture } from '../voice-capture-gate'

/**
 * 训练前的数据体检：重复句、录不出话的录音、稿子里还没录的句子，外加时长分布。
 *
 * 为什么是纯函数：这三类问题的判据（什么算重复、什么算「录不出话」）如果各写一遍，
 * 面板说的和开训脚本吃到的就会是两套标准。这里只吃事实（每条录音的采样点/音量），
 * 「录不出话」直接复用对讲那条判定 `judgeCapture`——同一组阈值，不另立一份。
 */

/** 体检最多点名几条 key：全列会撑成一堵墙，但计数照旧给准数。 */
export const HEALTH_KEYS_SHOWN = 6

export interface HealthTakeInput {
  /** Gxx-Lnn */
  key: string
  text: string
  /** 采样点、采样率与两档音量；读不了的文件给 0（于是判成「读不出声音」）。 */
  frames: number
  sampleRate: number
  rms: number
  peak: number
}

export type HealthIssueKind = 'duplicate' | 'unusable' | 'missing'

export interface HealthIssue {
  kind: HealthIssueKind
  /** 面板一行话说清是什么问题。 */
  label: string
  /** 点名到哪几条（超过 HEALTH_KEYS_SHOWN 只留前几条，全量在 detail 里）。 */
  keys: string[]
  /** 细节：带实测值或全量 key，事后能对着磁盘核。 */
  detail: string
}

export interface FtDatasetHealth {
  takes: number
  duration: { minMs: number; medianMs: number; maxMs: number; totalMs: number }
  issues: HealthIssue[]
  ok: boolean
}

/** 判重复只看文字本身：空白、大小写、全角空格都不该让同一句变成两句。 */
function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '')
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function cap(keys: readonly string[]): string[] {
  return keys.slice(0, HEALTH_KEYS_SHOWN)
}

export function judgeDatasetHealth(input: {
  takes: readonly HealthTakeInput[]
  /** 稿子里应有的全部 key（Gxx-Lnn）；自由说组不在其中。 */
  expected: readonly string[]
}): FtDatasetHealth {
  const issues: HealthIssue[] = []
  const durations = input.takes
    .map((take) => (take.sampleRate > 0 ? Math.round((take.frames / take.sampleRate) * 1000) : 0))
    .sort((left, right) => left - right)
  const duration = {
    minMs: durations[0] ?? 0,
    medianMs: median(durations),
    maxMs: durations.length > 0 ? durations[durations.length - 1] : 0,
    totalMs: durations.reduce((sum, ms) => sum + ms, 0)
  }

  // 重复：同一句稿子录了多遍（不同 key、同一文本）——训练集里等于给这句话加了双倍权重。
  const byText = new Map<string, string[]>()
  for (const take of input.takes) {
    const norm = normalizeText(take.text)
    if (norm.length === 0) continue
    const keys = byText.get(norm) ?? []
    keys.push(take.key)
    byText.set(norm, keys)
  }
  const duplicates = [...byText.entries()].filter(([, keys]) => keys.length > 1)
  if (duplicates.length > 0) {
    const keys = duplicates.flatMap(([, group]) => group)
    issues.push({
      kind: 'duplicate',
      label: `${duplicates.length} 句文本重复（同一句录了多遍）`,
      keys: cap(keys),
      detail: duplicates.map(([text, group]) => `「${text}」×${group.length}（${group.join('、')}）`).join('；')
    })
  }

  // 录不出话：沿用对讲那条判定（太短 / 静音 / 没有声音），不另立阈值。
  const rejected = input.takes
    .map((take) => ({ take, verdict: judgeCapture(take) }))
    .filter((row) => !row.verdict.ok)
  if (rejected.length > 0) {
    const reasons = new Map<string, number>()
    for (const row of rejected) reasons.set(row.verdict.reason ?? '', (reasons.get(row.verdict.reason ?? '') ?? 0) + 1)
    issues.push({
      kind: 'unusable',
      label: `${rejected.length} 条录不出话（${[...reasons.entries()].map(([reason, count]) => `${REASON_TEXT[reason] ?? reason} ${count}`).join('、')}）`,
      keys: cap(rejected.map((row) => row.take.key)),
      detail: rejected.map((row) => `${row.take.key} ${row.verdict.detail}`).join('；')
    })
  }

  // 缺句：稿子里写着，但磁盘上没有这条录音。
  const recorded = new Set(input.takes.map((take) => take.key))
  const missing = input.expected.filter((key) => !recorded.has(key))
  if (missing.length > 0) {
    issues.push({
      kind: 'missing',
      label: `稿子里还有 ${missing.length} 句没录`,
      keys: cap(missing),
      detail: missing.join('、')
    })
  }

  return { takes: input.takes.length, duration, issues, ok: issues.length === 0 }
}

const REASON_TEXT: Record<string, string> = {
  'too-short': '太短',
  silent: '静音',
  'no-signal': '没有声音'
}

/** 面板那一行：没问题说清条目与时长，有问题按「第一条 + 还有几条」说完。 */
export function healthLine(health: FtDatasetHealth): string {
  const seconds = Math.round(health.duration.totalMs / 100) / 10
  if (health.ok) return `${health.takes} 条 · 共 ${seconds} 秒 · 没有重复/静音/缺句`
  const first = health.issues[0]
  const rest = health.issues.length > 1 ? `，另外还有 ${health.issues.length - 1} 类` : ''
  return `${first.label}${rest} · ${health.takes} 条 · 共 ${seconds} 秒`
}
