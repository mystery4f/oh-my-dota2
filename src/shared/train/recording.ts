/** 录音判定纯缝（录音面板）：读哪份稿（resolveFtScript）、何时停（advanceRecording）、收不收（shouldKeepTake）、
 * 段叫什么（takeLineId/recordingKey）。 */
/** 试点（G15，20 句）实测阈值；改任何一项之前先过 --train-probe，再真人试录一遍。 */
export const RECORDING_LIMITS = {
  rmsThreshold: 0.012,
  quietMsToStop: 1200,
  minMs: 400,
  maxMs: 20000,
} as const

/** 一次录音的步进状态：探没探到说话、静音武装起于何时、从何时起录。 */
export interface RecordingStepState {
  speechSeen: boolean
  quietSince: number // 0 = 静音还没武装：说完话后的第一块安静样本才起表
  startedAt: number
}

/** 开录那一刻的状态。 */
export function initialRecordingState(nowMs: number): RecordingStepState {
  return { speechSeen: false, quietSince: 0, startedAt: nowMs }
}

/**
 * 每块音频走一步：超阈值记「说过话」并解除静音武装；说完连静 quietMsToStop 自动停
 * （读稿节奏就是句间停一秒），maxMs 硬上限兜底。静音时限先判、上限后判，同一步都命中
 * 时 reason 归先判中的。只做决策，不碰 MediaStream——采样管线留在渲染端。
 */
export function advanceRecording(
  state: RecordingStepState,
  input: { rms: number; nowMs: number },
): { state: RecordingStepState; stop: boolean; reason: string | null } {
  const next: RecordingStepState = { ...state }
  let stop = false
  let reason: string | null = null
  if (input.rms >= RECORDING_LIMITS.rmsThreshold) {
    next.speechSeen = true
    next.quietSince = 0
  } else if (next.speechSeen) {
    if (!next.quietSince) next.quietSince = input.nowMs
    else if (input.nowMs - next.quietSince >= RECORDING_LIMITS.quietMsToStop) {
      stop = true
      reason = '自动停'
    }
  }
  if (!stop && input.nowMs - next.startedAt >= RECORDING_LIMITS.maxMs) {
    stop = true
    reason = `到 ${RECORDING_LIMITS.maxMs / 1000}s 上限`
  }
  return { state: next, stop, reason }
}

/**
 * 收尾判定：太短丢；全程没探到说话（哑麦/阈值漏探）的静音段也丢——静音配稿子是脏样本。
 * 时长判定在前，两条件同犯时报「太短」。
 */
export function shouldKeepTake({ durationMs, speechSeen }: { durationMs: number; speechSeen: boolean }): {
  keep: boolean
  reason: string | null
} {
  if (durationMs < RECORDING_LIMITS.minMs) return { keep: false, reason: `太短（${durationMs}ms），丢弃了——重新点录制` }
  if (!speechSeen) return { keep: false, reason: '没检测到说话，丢弃——重新点录制' }
  return { keep: true, reason: null }
}

/** 段序号键：逐句组 L+两位序号，自由说组 T+两位序号。 */
export function takeLineId(mode: 'lines' | 'free', no: number): string {
  return `${mode === 'free' ? 'T' : 'L'}${String(no).padStart(2, '0')}`
}

/** 录音键的合法形状：组 Gxx、句 Lxx（逐句）或 Txx（自由说）。格式化与主进程写盘白名单共用这一条知识。 */
export const RECORDING_GROUP_SHAPE = /^G\d{2}$/
export const RECORDING_LINE_SHAPE = /^(?:L|T)\d{2}$/

/** 校验并归一（组号，句号）字符串对，非法输入抛错；主进程写盘靠它防路径穿越。 */
export function parseRecordingKeyParts(group: string, line: string): { group: string; line: string } {
  const g = RECORDING_GROUP_SHAPE.exec(group)
  const l = RECORDING_LINE_SHAPE.exec(line)
  if (!g || !l) throw new Error(`非法的组/句号：${group}-${line}`)
  return { group: g[0], line: l[0] }
}

/** 完整录音键（Gxx-Lnn / Gxx-Tnn）：渲染端查表用；主进程写盘前经 parseRecordingKeyParts 白名单校验。 */
export function recordingKey(groupId: string, mode: 'lines' | 'free', no: number): string {
  return `${groupId}-${takeLineId(mode, no)}`
}

/**
 * 存完一条后该落到哪一句：从当前句往后找第一条没录的，到末尾再回绕到开头；
 * 全组都录过 = null（面板显示完成态、停在原地，不再跳）。
 * 候选里永远只有**没录过**的行，且排除当前句——所以自动前进绝不会落在已录行上，
 * 覆盖只可能来自手动点句号。录失败/没麦克风时调用方压根不该走到这里。
 */
export function nextUnrecordedLine(input: {
  lines: readonly number[]
  recorded: readonly number[]
  current: number
}): number | null {
  const done = new Set(input.recorded)
  const pending = input.lines.filter((no) => no !== input.current && !done.has(no))
  if (pending.length === 0) return null
  return pending.find((no) => no > input.current) ?? pending[0]
}

/** 读稿一句：`1. 文本` 的序号与正文。 */
export interface FtScriptLine {
  no: number
  text: string
}

/** 读稿一组：`## Gxx 标题` 开组，逐句组的 lines 逐条录，没有编号句的组是自由说。 */
export interface FtScriptGroup {
  id: string
  title: string
  mode: 'lines' | 'free'
  lines: FtScriptLine[]
  note: string
}

/** 这份读稿从哪来：数据目录的自定义稿，还是随包自带的那份。 */
export type FtScriptSource = 'data' | 'bundled'

/** 一份候选读稿：markdown 为 null 表示文件不存在或读不出来。 */
export interface FtScriptCandidate {
  path: string
  markdown: string | null
}

/** 面板要用的一整份读稿：句子、生效来源、路径、以及回落/失效的说明。 */
export interface FtScriptState {
  groups: FtScriptGroup[]
  source: FtScriptSource
  /** 生效读稿的绝对路径：面板把它印出来，用户才找得到该改哪个文件。 */
  path: string
  /** 非空 = 自定义稿坏了、已回落自带稿：句子照常可录，但这条告警必须显示。 */
  warning: string | null
  /** 非空 = 连自带稿都不可用：页面没有句子可录，不是「还没读出来」。 */
  error: string | null
}

/** 解析读稿 markdown：`## Gxx 标题` 开组，`1. 文本` 收句；一组没有编号句就是自由说组。 */
export function parseFtScript(markdown: string): FtScriptGroup[] {
  const groups: FtScriptGroup[] = []
  let current: FtScriptGroup | null = null
  const noteParts: string[] = []
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const groupMatch = /^##\s+(G\d+)\s*(.*)$/.exec(line)
    if (groupMatch) {
      if (current) current.note = noteParts.join(' ')
      current = { id: groupMatch[1], title: groupMatch[2].trim(), mode: 'lines', lines: [], note: '' }
      groups.push(current)
      noteParts.length = 0
      continue
    }
    if (!current) continue
    const lineMatch = /^(\d{1,3})[.、]\s*(.+)$/.exec(line)
    if (lineMatch) current.lines.push({ no: Number(lineMatch[1]), text: lineMatch[2].trim() })
    else noteParts.push(line)
  }
  if (current) current.note = noteParts.join(' ')
  for (const group of groups) if (group.lines.length === 0) group.mode = 'free'
  return groups
}

/** 一份 markdown 能不能拿去录；defect 说人话，null = 能用。 */
function assessScript(markdown: string | null): { groups: FtScriptGroup[]; defect: string | null } {
  if (markdown === null) return { groups: [], defect: '缺失' }
  // readFile('utf8') 把坏字节解成 U+FFFD：混进替换字符的稿子宁可回落，也不拿去录成脏样本。
  if (markdown.includes('\uFFFD')) return { groups: [], defect: '编码不是 UTF-8' }
  if (!markdown.trim()) return { groups: [], defect: '是空的' }
  const groups = parseFtScript(markdown)
  return { groups, defect: groups.length === 0 ? '格式不对（要 `## G14` 组标题 + 编号句）' : null }
}

/**
 * 读稿选择：数据目录的自定义稿优先，不存在或坏了才回落随包自带的。
 * 只有自带那份也不可用时才是 error——那时页面真的没句子可录；自定义稿坏了只是 warning，
 * 因为「我改错了文件」不该把整个录音页变成空白。IO（读三个候选文件）留在主进程。
 */
export function resolveFtScript(data: FtScriptCandidate, bundled: FtScriptCandidate): FtScriptState {
  const user = data.markdown === null ? null : assessScript(data.markdown)
  if (user && user.defect === null) {
    return { groups: user.groups, source: 'data', path: data.path, warning: null, error: null }
  }
  const built = assessScript(bundled.markdown)
  if (built.defect === null) {
    return {
      groups: built.groups,
      source: 'bundled',
      path: bundled.path,
      warning: user === null ? null : `数据目录的读稿（${data.path}）${user.defect}，已回落到自带读稿`,
      error: null
    }
  }
  return {
    groups: [],
    source: 'bundled',
    path: bundled.path,
    warning: null,
    error: `内置读稿（${bundled.path}）${built.defect}——重装或检查应用资源`
  }
}

/**
 * 录音键 → 稿子那一句的正文。存盘时用它把「录的是哪一句」落进账本，待训数字才对得上。
 * 自由说（Tnn）和稿子上没有的行返回 null——没有标准答案的录音不进账本（也就不算待训）。
 */
export function scriptTextForKey(groups: readonly FtScriptGroup[], key: string): string | null {
  const match = /^(G\d{2})-(L|T)(\d{2})$/.exec(key)
  if (!match || match[2] !== 'L') return null
  const group = groups.find((item) => item.id === match[1])
  if (!group || group.mode !== 'lines') return null
  return group.lines.find((line) => line.no === Number(match[3]))?.text ?? null
}

/* ── 读稿编辑器（面板抽屉）：序列化与增删改都是纯函数，IO 留在主进程 ────────────── */

/** 编辑结果：改不动就说人话，绝不静默返回原对象让面板以为存上了。 */
export type FtScriptEdit = { ok: true; groups: FtScriptGroup[] } | { ok: false; error: string }

/** 读稿开头那段说明（第一个 `## Gxx` 之前的一切）：编辑保存时原样带回去，别把说明吃掉。 */
export function scriptPreamble(markdown: string): string {
  const match = /^##\s+G\d+/m.exec(markdown)
  if (!match) return markdown.trim() ? `${markdown.replace(/\s+$/, '')}\n` : ''
  return markdown.slice(0, match.index)
}

/**
 * 序列化回 markdown：与 parseFtScript 严格往返（组标题、编号句、组说明）。
 * numbers 允许断号——编辑器只追加不重排，`G14-L07` 这类键才不会挪位。
 */
export function serializeFtScript(groups: readonly FtScriptGroup[], preamble = ''): string {
  const parts: string[] = []
  const head = preamble.replace(/\s+$/, '')
  if (head) parts.push(head, '')
  for (const group of groups) {
    parts.push(`## ${group.id}${group.title ? ` ${group.title}` : ''}`)
    for (const line of group.lines) parts.push(`${line.no}. ${line.text}`)
    if (group.note) parts.push(group.note)
    parts.push('')
  }
  return `${parts.join('\n').replace(/\s+$/, '')}\n`
}

/** 下一个没被占用的组号（G01…G99）：满了就 null，面板据此禁用「新建组」。 */
export function nextGroupId(groups: readonly FtScriptGroup[]): string | null {
  const used = new Set(groups.map((group) => group.id))
  for (let no = 1; no <= 99; no += 1) {
    const id = `G${String(no).padStart(2, '0')}`
    if (!used.has(id)) return id
  }
  return null
}

function findGroup(groups: readonly FtScriptGroup[], groupId: string): FtScriptGroup | null {
  return groups.find((group) => group.id === groupId) ?? null
}

/** 新建组：标题留空也行，句号为空的组按 parseFtScript 的规则算自由说。 */
export function addScriptGroup(groups: readonly FtScriptGroup[], title: string): FtScriptEdit {
  const id = nextGroupId(groups)
  if (id === null) return { ok: false, error: '组号用完了（G01–G99）——先删掉不用的组' }
  return { ok: true, groups: [...groups, { id, title: title.trim(), mode: 'lines', lines: [], note: '' }] }
}

/** 改组标题：自由说组也能改标题（它的 wav 不按行号命名，标题只是给人看的）。 */
export function renameScriptGroup(
  groups: readonly FtScriptGroup[],
  groupId: string,
  title: string
): FtScriptEdit {
  if (!findGroup(groups, groupId)) return { ok: false, error: `没有 ${groupId} 这一组` }
  return {
    ok: true,
    groups: groups.map((group) => (group.id === groupId ? { ...group, title: title.trim() } : group))
  }
}

/** 追加一句到组末：编号取组内最大值 +1，不重排任何已有编号（否则已录的键会全部挪位）。 */
export function appendScriptLine(
  groups: readonly FtScriptGroup[],
  groupId: string,
  text: string
): FtScriptEdit {
  const group = findGroup(groups, groupId)
  if (!group) return { ok: false, error: `没有 ${groupId} 这一组` }
  const body = text.trim()
  if (!body) return { ok: false, error: '句子是空的' }
  if (group.mode === 'free' && group.lines.length === 0) {
    return { ok: false, error: `${groupId} 是自由说组：它的录音不按行号命名，不能加句子` }
  }
  const no = group.lines.reduce((max, line) => Math.max(max, line.no), 0) + 1
  return {
    ok: true,
    groups: groups.map((item) =>
      item.id === groupId ? { ...item, mode: 'lines', lines: [...item.lines, { no, text: body }] } : item
    )
  }
}

/** 改一句的正文：编号不动——同一个 `Gxx-Lnn` 换文本，面板据此把该行标成「需重录」。 */
export function updateScriptLine(
  groups: readonly FtScriptGroup[],
  key: string,
  text: string
): FtScriptEdit {
  const body = text.trim()
  if (!body) return { ok: false, error: '句子不能改成空的（要删就删这一行）' }
  let hit = false
  const next = groups.map((group) => {
    const lines = group.lines.map((line) => {
      if (recordingKey(group.id, 'lines', line.no) !== key) return line
      hit = true
      return { ...line, text: body }
    })
    return lines === group.lines ? group : { ...group, lines }
  })
  if (!hit) return { ok: false, error: `稿子里没有 ${key} 这一句` }
  return { ok: true, groups: next }
}

/** 删一句：编号不重排。已经录过的 wav 会变成孤儿，删之前由面板告警（纯缝不碰磁盘）。 */
export function deleteScriptLine(groups: readonly FtScriptGroup[], key: string): FtScriptEdit {
  let hit = false
  const next = groups.map((group) => {
    const lines = group.lines.filter((line) => {
      const match = recordingKey(group.id, 'lines', line.no) === key
      if (match) hit = true
      return !match
    })
    return lines.length === group.lines.length ? group : { ...group, lines }
  })
  if (!hit) return { ok: false, error: `稿子里没有 ${key} 这一句` }
  return { ok: true, groups: next.map((group) => (group.lines.length === 0 ? { ...group, mode: 'free' } : group)) }
}

/** 删整组：录音文件不动（面板负责说清哪些 wav 变孤儿）。 */
export function deleteScriptGroup(groups: readonly FtScriptGroup[], groupId: string): FtScriptEdit {
  if (!findGroup(groups, groupId)) return { ok: false, error: `没有 ${groupId} 这一组` }
  return { ok: true, groups: groups.filter((group) => group.id !== groupId) }
}
