/**
 * 机器级事实：Python 解释器在不在、依赖齐不齐、显存够不够（#179）。
 *
 * 为什么单独一条缝：这三件都不是「应用自己的状态」，而是「这台机器能不能跑训练 / 合成」。
 * 识别训练页和音色页都需要它，两页各拼一份句子必然走样；判据（多少 MiB 才算够）原样复用
 * `src/shared/train/asr-ft.ts` 的 `judgeFtVram` / `ftVramNote`，调用方把结论喂进来，这里只做折叠。
 *
 * 三行固定顺序 python → deps → vram。`unknown` 与 `ok` 绝不合并：测不到要写原因，
 * 写「正常」就是在骗人（这条是本仓反复踩过的坑）。
 */

export type MachineRowId = 'python' | 'deps' | 'vram'

export type MachineState = 'ok' | 'warn' | 'bad' | 'unknown'

/** 一行里的小段：同一行可能有两条腿（识别训练 / 音色合成），各自状态与文字分开给。 */
export interface MachineSegment {
  label: string
  state: MachineState
  text: string
}

export interface MachineRow {
  id: MachineRowId
  label: string
  state: MachineState
  /** 一行正文：读的人只看这一句就要知道「行不行」。 */
  line: string
  /** 为什么在意：面板原样显示，页面不许自己拼。 */
  why: string
  segments: MachineSegment[]
}

/** 一个解释器的探测结果：`path` 为空表示没装；`error` 非空表示装了但问不出来。 */
export interface PythonFacts {
  path: string | null
  version: string | null
  error: string | null
}

/** 显存：数字由 `judgeFtVram()` 算出，`note` 是 `ftVramNote()` 的原话（够用时为 null）。 */
export interface VramFacts {
  totalMiB: number
  usedMiB: number
  freeMiB: number
  ok: boolean
  needMiB: number
  holders: readonly string[]
  note: string | null
}

export interface MachineEnvFacts {
  asrPython: PythonFacts
  gvPython: PythonFacts
  /** 缺的包名；空数组 = 齐。`null` + `*DepsError` = 测不到（解释器不在 / 问不出来），不许当成「齐」。 */
  asrMissing: readonly string[] | null
  gvMissing: readonly string[] | null
  asrDepsError: string | null
  gvDepsError: string | null
  /** null = 没测（没有 nvidia-smi / 查不动），与 `ok: false`（测到了但不够）不是一回事。 */
  vram: VramFacts | null
  vramError: string | null
}

export interface MachineEnvReport {
  at: string
  rows: MachineRow[]
  /** 汇总句：全绿一句、有 bad 一句、有 unknown 一句，三种都能一眼分清。 */
  line: string
  ready: boolean
}

export const PYTHON_WHY =
  '训练脚本和音色合成都要跑在装好依赖的解释器里：Python 不在，两条路都起不来。'

export const DEPS_WHY = '缺包时脚本会在 import 那一行退出，界面上只看到「失败」看不到原因。'

export const VRAM_WHY = '显存不够训练会在中途报 CUDA OOM，前面跑的时间全丢。'

/**
 * 音色合成（GV）脚本 import 的就是这四个；写死在这里而不是扫 requirements.txt —— 安装包里不一定有那份文件。
 * 每个都写「为什么需要它」：只给名字的话，用户看到「缺 soundfile」不知道这跟他听到的哑巴有什么关系。
 */
export const GV_PY_DEPS: readonly { name: string; why: string }[] = [
  { name: 'torch', why: '推理运行时，整个合成图都建在它上面' },
  { name: 'torchaudio', why: '读参考音频（切分与重采样都走它）' },
  { name: 'numpy', why: '张量进出与波形拼接' },
  { name: 'soundfile', why: '把合成结果写成前端能播的 wav' }
]

function pythonSegment(label: string, facts: PythonFacts): MachineSegment {
  if (facts.path === null) {
    return { label, state: 'bad', text: `${label}：没装（找不到解释器）` }
  }
  if (facts.error !== null) {
    return { label, state: 'unknown', text: `${label}：测不到版本（${facts.error}）` }
  }
  return { label, state: 'ok', text: `${label}：${facts.version ?? '在'}` }
}

function pythonRow(facts: MachineEnvFacts): MachineRow {
  const segments = [
    pythonSegment('识别训练', facts.asrPython),
    pythonSegment('音色合成', facts.gvPython)
  ]
  const bad = segments.filter((one) => one.state === 'bad')
  const unknown = segments.filter((one) => one.state === 'unknown')
  const state: MachineState = bad.length > 0 ? 'bad' : unknown.length > 0 ? 'unknown' : 'ok'
  const line =
    bad.length > 0
      ? `${bad.map((one) => one.label).join('、')}的解释器不在：对应的安装入口重装一次就能补上`
      : unknown.length > 0
        ? `${unknown.map((one) => one.label).join('、')}：解释器在，但版本问不出来（可能被别的进程占着）`
        : '两个解释器都在'
  return { id: 'python', label: 'Python', state, line, why: PYTHON_WHY, segments }
}

/** 缺的包名（两腿合并、去重）：行里必须点名，不然「缺包」三个字让人无处下手。 */
function missingNames(facts: MachineEnvFacts): string[] {
  const names = [...(facts.asrMissing ?? []), ...(facts.gvMissing ?? [])]
  return [...new Set(names)]
}

function depsLeg(
  name: string,
  missing: readonly string[] | null,
  error: string | null
): MachineSegment {
  if (missing === null) {
    return { label: name, state: 'unknown', text: `${name}：测不到（${error ?? '解释器不在'}）` }
  }
  if (missing.length === 0) return { label: name, state: 'ok', text: `${name}：齐` }
  const reasons = missing
    .map((one) => {
      const known = GV_PY_DEPS.find((dep) => dep.name === one)
      return known === undefined ? one : `${one}（${known.why}）`
    })
    .join('、')
  return { label: name, state: 'bad', text: `${name}：缺 ${reasons}` }
}

function depsRow(facts: MachineEnvFacts): MachineRow {
  const segments = [
    depsLeg('识别训练', facts.asrMissing, facts.asrDepsError),
    depsLeg('音色合成', facts.gvMissing, facts.gvDepsError)
  ]
  const bad = segments.filter((one) => one.state === 'bad')
  const unknown = segments.filter((one) => one.state === 'unknown')
  const state: MachineState = bad.length > 0 ? 'bad' : unknown.length > 0 ? 'unknown' : 'ok'
  const line =
    bad.length > 0
      ? `${bad.map((one) => one.label).join('、')}缺 ${missingNames(facts).join('、')}：在对应解释器里 pip install 一次就补上（别用系统 Python）`
      : unknown.length > 0
        ? `${unknown.map((one) => one.label).join('、')}：测不到（${facts.asrDepsError ?? facts.gvDepsError ?? '解释器不在'}）`
        : '两条腿要的包都齐'
  return { id: 'deps', label: '依赖', state, line, why: DEPS_WHY, segments }
}

/**
 * 依赖那一行的短句，供页面与别的行拼成一句话（#179 要求：和识别训练页「引擎包没装」拼起来是
 * 一句话，不是两句并列）。返回空串表示「没什么要说的」。
 */
export function depsClause(report: MachineEnvReport): string {
  const row = report.rows.find((one) => one.id === 'deps')
  if (row === undefined || row.state === 'ok') return ''
  return row.line.replace(/。$/, '')
}

function vramRow(facts: MachineEnvFacts): MachineRow {
  if (facts.vram === null) {
    const reason = facts.vramError ?? '没有 nvidia-smi（可能是核显或驱动没装）'
    return {
      id: 'vram',
      label: '显存',
      state: 'unknown',
      line: `测不到：${reason}`,
      why: VRAM_WHY,
      segments: [{ label: '显存', state: 'unknown', text: '测不到' }]
    }
  }
  const one = facts.vram
  const state: MachineState = one.ok ? 'ok' : 'warn'
  const holders = one.holders.length > 0 ? `；占卡的是 ${one.holders.join('、')}` : ''
  const line = one.ok
    ? `够用：可空出 ${one.freeMiB} MiB（训练建议 ${one.needMiB} MiB）`
    : `${one.note ?? `偏紧：可空出 ${one.freeMiB} MiB（训练建议 ${one.needMiB} MiB）`}${holders}`
  return {
    id: 'vram',
    label: '显存',
    state,
    line,
    why: VRAM_WHY,
    segments: [
      {
        label: `${one.usedMiB} / ${one.totalMiB} MiB 已用`,
        state,
        text: `可空出 ${one.freeMiB} MiB`
      }
    ]
  }
}

/** 三行 + 一句汇总。顺序固定，页面不许重排（两页显示同一件事，顺序不同会让人以为数据不同）。 */
export function judgeMachineEnv(facts: MachineEnvFacts): MachineEnvReport {
  const rows = [pythonRow(facts), depsRow(facts), vramRow(facts)]
  const bad = rows.filter((row) => row.state === 'bad')
  const unknown = rows.filter((row) => row.state === 'unknown')
  const warn = rows.filter((row) => row.state === 'warn')
  const ready = bad.length === 0 && unknown.length === 0
  const line =
    bad.length > 0
      ? `${bad.length} 项不齐：${bad.map((row) => row.label).join('、')}`
      : unknown.length > 0
        ? `${unknown.length} 项测不到：${unknown.map((row) => row.label).join('、')}`
        : warn.length > 0
          ? `都齐了，但 ${warn.map((row) => row.label).join('、')}偏紧`
          : '这台机器能跑训练与合成'
  return { at: new Date().toISOString(), rows, line, ready }
}

/** 页面上那一行的文字：汇总句 + 三行各自的短句，`<Row>` 的 hint 直接用。 */
export function machineEnvLine(report: MachineEnvReport): string {
  return [report.line, ...report.rows.map((row) => row.line)].join(' · ')
}

/** 有没有哪一行真的坏了（决定 pill 语气）：测不到不算坏，但也绝不显示成绿。 */
export function machineEnvState(report: MachineEnvReport): MachineState {
  if (report.rows.some((row) => row.state === 'bad')) return 'bad'
  if (report.rows.some((row) => row.state === 'unknown')) return 'unknown'
  if (report.rows.some((row) => row.state === 'warn')) return 'warn'
  return 'ok'
}
