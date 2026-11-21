/**
 * 环境自检的判据与措辞。这一页存在的理由：用户报「识别慢」「没声音」「连不上」时，
 * 我们第一件事总是问「你机器什么样」，而应用自己从不回答。所以每一行都必须量到真值、
 * 说清为什么在意、以及怎么改；量不到的就说量不到——用绿色掩盖「不知道」比报错更伤人。
 *
 * 判据在这里，取数在主进程（CPU/内存/磁盘/端口）与渲染层（设备数量）。两者都只是
 * 把事实塞进 `EnvFacts`，判断与措辞全在这一个文件里。
 */

/** 内存低于这个数就提醒：识别和训练都会瞬间把机器吃到十几秒不响应。 */
export const MEM_TIGHT_BYTES = 1.5 * 1024 ** 3

/** 数据目录所在盘低于这个数就提醒：一次全量训练的权重就有十几 GB。 */
export const DISK_TIGHT_BYTES = 5 * 1024 ** 3

export type EnvRowId = 'cpu' | 'memory' | 'disk' | 'port' | 'mic' | 'speaker'

/** unknown 是独立状态，不是 ok 的一种：没有数据就说没有数据。 */
export type EnvState = 'ok' | 'warn' | 'bad' | 'unknown'

export interface EnvRow {
  id: EnvRowId
  label: string
  state: EnvState
  /** 量到的值。null = 没量到，此时 state 必须是 unknown。 */
  value: string | null
  /** 为什么这件事值得看一眼。每行都有，不是错误提示。 */
  why: string
  /** 量不到时的原因；量到了就是 null。 */
  gap: string | null
}

export interface EnvReport {
  at: string
  rows: EnvRow[]
}
/** 设备数是渲染层量的（`navigator.mediaDevices.enumerateDevices()` 数 kind），主进程拿着它
 *  和机器值拼成一份体检；null = 渲染层没给出清单（还没枚举 / 浏览器拒绝）。 */
export interface EnvDeviceCounts {
  micCount: number | null
  speakerCount: number | null
}

/** 端口那一行的三态：我们自己占着（正常）、别人占着（要处理）、空着（GSI 没在听）。 */
export type PortOwner = 'ours' | 'other' | 'free' | null

export interface EnvFacts {
  cpuModel: string | null
  cpuCores: number | null
  freeMemBytes: number | null
  totalMemBytes: number | null
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  /** 被量的是哪个目录所在盘，写进 value 里，人才知道「磁盘余量」说的是哪块盘。 */
  diskPath: string | null
  gsiPort: number | null
  portOwner: PortOwner
  micCount: number | null
  speakerCount: number | null
}

export const EMPTY_ENV_FACTS: EnvFacts = {
  cpuModel: null,
  cpuCores: null,
  freeMemBytes: null,
  totalMemBytes: null,
  diskFreeBytes: null,
  diskTotalBytes: null,
  diskPath: null,
  gsiPort: null,
  portOwner: null,
  micCount: null,
  speakerCount: null
}

const GIB = 1024 ** 3
const MIB = 1024 ** 2

/** 人读的容量：小于 1 GiB 用 MiB，否则一位小数的 GiB。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${Math.round(bytes / MIB)} MB`
}

function cpuRow(facts: EnvFacts): EnvRow {
  const why = '训练和本地识别都吃 CPU：核数少不是故障，但会决定「一句话要等多久」。'
  if (facts.cpuCores === null || facts.cpuCores <= 0) {
    return { id: 'cpu', label: 'CPU', state: 'unknown', value: null, why, gap: '系统没报出处理器信息' }
  }
  const model = facts.cpuModel?.trim() ? facts.cpuModel.trim() : null
  const cores = `${facts.cpuCores} 个逻辑核心`
  return { id: 'cpu', label: 'CPU', state: 'ok', value: model ? `${model} · ${cores}` : cores, why, gap: null }
}

function memoryRow(facts: EnvFacts): EnvRow {
  const why = '空闲内存不够时，识别会卡住几秒、训练会直接失败（显存之外还要内存）。'
  if (facts.freeMemBytes === null || facts.totalMemBytes === null || facts.totalMemBytes <= 0) {
    return { id: 'memory', label: '空闲内存', state: 'unknown', value: null, why, gap: '系统没报出内存用量' }
  }
  const free = facts.freeMemBytes
  const total = facts.totalMemBytes
  const percent = Math.round((free / total) * 100)
  const value = `可用 ${formatBytes(free)} / 共 ${formatBytes(total)}（${percent}%）`
  if (free < MEM_TIGHT_BYTES) {
    return { id: 'memory', label: '空闲内存', state: 'warn', value, why, gap: null }
  }
  return { id: 'memory', label: '空闲内存', state: 'ok', value, why, gap: null }
}

function diskRow(facts: EnvFacts): EnvRow {
  const why = '模型与训练产物都写在数据目录里：一次全量微调的权重有十几 GB，盘满时训练会进行到一半才失败。'
  if (facts.diskFreeBytes === null || facts.diskTotalBytes === null) {
    return { id: 'disk', label: '磁盘余量', state: 'unknown', value: null, why, gap: '读不到这块盘的剩余空间' }
  }
  const where = facts.diskPath ? `（${facts.diskPath}）` : ''
  const value = `余 ${formatBytes(facts.diskFreeBytes)} / 共 ${formatBytes(facts.diskTotalBytes)}${where}`
  if (facts.diskFreeBytes < DISK_TIGHT_BYTES) {
    return { id: 'disk', label: '磁盘余量', state: 'warn', value, why, gap: null }
  }
  return { id: 'disk', label: '磁盘余量', state: 'ok', value, why, gap: null }
}

function portRow(facts: EnvFacts): EnvRow {
  const port = facts.gsiPort === null ? 'GSI 端口' : `GSI 端口 ${facts.gsiPort}`
  const why =
    'Dota 把对局状态与聊天推到这个本地端口，而它是单实例的：被占通常是另一个 oh-my-dota2 或 Logitech 的 GSI 进程还开着，占着的那一个收得到、剩下的都一条不收。'
  if (facts.portOwner === null) {
    return { id: 'port', label: '端口占用', state: 'unknown', value: null, why, gap: '这次没探测端口' }
  }
  if (facts.portOwner === 'ours') {
    return { id: 'port', label: '端口占用', state: 'ok', value: `${port} 由本应用监听`, why, gap: null }
  }
  if (facts.portOwner === 'other') {
    return { id: 'port', label: '端口占用', state: 'bad', value: `${port} 被别的程序占着`, why, gap: null }
  }
  return { id: 'port', label: '端口占用', state: 'warn', value: `${port} 空着（本应用没在监听）`, why, gap: null }
}

function deviceRow(id: 'mic' | 'speaker', facts: EnvFacts): EnvRow {
  const count = id === 'mic' ? facts.micCount : facts.speakerCount
  const label = id === 'mic' ? '输入设备' : '输出设备'
  const why =
    id === 'mic'
      ? '对讲要录你的声音：一个麦克风都没枚举到，按了热键也只会录到静音。'
      : '朗读和对讲回放都要送到一个输出设备：一个都没有时合成成功也听不见。'
  if (count === null) {
    return { id, label, state: 'unknown', value: null, why, gap: '浏览器层没给出设备清单（可能还没授权过麦克风）' }
  }
  const value = count === 0 ? '一个都没找到' : `${count} 个`
  return { id, label, state: count === 0 ? 'warn' : 'ok', value, why, gap: null }
}

/** 固定顺序：先机器（CPU/内存/磁盘），再链路（端口），最后设备。 */
export function judgeEnv(facts: EnvFacts): EnvReport {
  const rows = [
    cpuRow(facts),
    memoryRow(facts),
    diskRow(facts),
    portRow(facts),
    deviceRow('mic', facts),
    deviceRow('speaker', facts)
  ]
  return { at: new Date().toISOString(), rows }
}

/** 一行能不能算「看到了」：只有 ok/warn/bad 有数据，unknown 不算。 */
export function envCounted(report: EnvReport): number {
  return report.rows.filter((row) => row.state !== 'unknown').length
}

/** 有事的行（warn/bad）。unknown 不在里面：不知道不等于有问题。 */
export function envTroubled(report: EnvReport): EnvRow[] {
  return report.rows.filter((row) => row.state === 'warn' || row.state === 'bad')
}

/** 入口文案只写一次：三处告警都用它，改词不会漏掉一处（#140）。 */
export const MACHINE_CHECK_LABEL = '看这台机器'

export interface MachineCheckOffer {
  show: boolean
  label: string
  hint: string
}

/**
 * 「看这台机器」入口该不该出现（#140）。
 *
 * 只在真有告警时出现：全绿时留一个点进去看不出任何东西的按钮，比不给入口更糟——
 * 用户会以为那按钮能修好什么。`null`/`undefined` 是「还没测」，与「绿」不同，也不算告警。
 */
export function machineCheckOffer(warnings: readonly (boolean | null | undefined)[]): MachineCheckOffer {
  const show = warnings.some((warned) => warned === true)
  return {
    show,
    label: MACHINE_CHECK_LABEL,
    hint: show
      ? '这台机器六行体检里能看到 CPU、内存、磁盘、端口、输入/输出设备的实际数字'
      : '没有告警时不出现这个入口'
  }
}
