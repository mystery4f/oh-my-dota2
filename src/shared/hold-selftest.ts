/**
 * 按住检测的自检口径（#95）。
 *
 * 「按住说话」的地基是一个常驻 PowerShell 进程：Electron 的 globalShortcut 只通知按下，
 * 松开那一下只有那个进程知道。它崩了会重试 5 次，再不行就退回「敲一下」注册——降级本身
 * 是对的，问题是**降级没人看得见**：用户按住热键说完整整一句话，什么都没发生，只能怀疑
 * 自己按错了。
 *
 * 所以这里把「现在到底有没有人在听松开」摊成两件事：常驻脚本的在场状态，和最近收到的边。
 * 边是真的按下/松开（press / release），前端只读这两个数组，不猜。
 */

/** 常驻脚本的在场状态。`off` = 语音对讲不是按住模式，本来就不该有进程。 */
export type HoldPresence = 'off' | 'starting' | 'resident' | 'fallback'

/** 一条边。press / release 各自一条，时间来自主进程时钟。 */
export interface HoldEdge {
  at: number
  kind: 'press' | 'release'
}

/** 主进程回给面板的全部事实。`edges` 是最新的若干条，旧的丢掉。 */
export interface HoldSelfTest {
  presence: HoldPresence
  /** 常驻脚本回报过 `OK`（脚本起来且组合键解析成功）。 */
  ready: boolean
  /** 连续重开次数：0 表示刚才就绪过，>0 表示正在退避重试。 */
  attempts: number
  /** 退回「敲一下」的原因；`presence === 'fallback'` 时必须有值。 */
  fallbackReason: string | null
  edges: HoldEdge[]
}

/** 面板只读这几项，不必自己数边。 */
export interface HoldEdgeSummary {
  presses: number
  releases: number
  /** 成对的次数（press 之后跟到 release）。 */
  pairs: number
  /** 最近一次成对按住的时长；没有成对的按住时为 null。 */
  heldMs: number | null
  /** 最近一条边的时间。 */
  lastAt: number | null
}

export interface HoldHealthView {
  tone: 'ready' | 'warn' | 'bad' | 'idle'
  title: string
  hint: string
}

export const HOLD_EDGE_KEEP = 24

/**
 * 数边。成对才算「按住过一次」——只有 press 没有 release 恰恰是「松开丢了」的那种病，
 * 它要显示成 press>release，而不是被四舍五入成一次正常按住。
 */
export function summarizeHoldEdges(edges: readonly HoldEdge[]): HoldEdgeSummary {
  let presses = 0
  let releases = 0
  let pairs = 0
  let heldMs: number | null = null
  let lastAt: number | null = null
  let open: number | null = null
  for (const edge of edges) {
    if (lastAt === null || edge.at > lastAt) lastAt = edge.at
    if (edge.kind === 'press') {
      presses += 1
      open = edge.at
      continue
    }
    releases += 1
    if (open !== null) {
      pairs += 1
      heldMs = Math.max(0, edge.at - open)
      open = null
    }
  }
  return { presses, releases, pairs, heldMs, lastAt }
}

/** 「1.2 s」这种写法；0 也算 0，不写成空。 */
export function formatHeld(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 1000)} s`
}

/** 本地时分秒，面板里只用来分辨「是不是刚才那一下」。 */
export function formatEdgeClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 一行字的结论。文案纪律：退回敲一下时**必须**说清「按住不生效」和怎么用；
 * 任何状态都不许写「已恢复 / 已修复」——降级不是修复。
 */
export function judgeHoldHealth(report: HoldSelfTest): HoldHealthView {
  const summary = summarizeHoldEdges(report.edges)
  if (report.presence === 'off') {
    return {
      tone: 'idle',
      title: '未启用',
      hint: '语音对讲是「敲一下」模式，没有常驻轮询进程。想用按住说话，上面切成「按住」。'
    }
  }
  if (report.presence === 'fallback') {
    return {
      tone: 'bad',
      title: '已退回敲一下',
      hint: `${report.fallbackReason ?? '常驻脚本起不来'}——按住不会生效：现在按一下开始录，再按一下结束。修好之后在面板重新保存热键表即可切回按住。`
    }
  }
  if (report.presence === 'starting' || !report.ready) {
    return {
      tone: 'warn',
      title: '常驻脚本正在起来',
      hint: 'PowerShell 冷启动要一两秒；起来之前按下的键会被漏掉。再等一会儿，计数开始涨就说明在听。'
    }
  }
  if (summary.presses === 0) {
    return {
      tone: 'warn',
      title: '脚本在跑，还没收到过按下',
      hint: '按住热键说一句话，下面两个计数会一起涨；只涨「按下」不涨「松开」就是松开信号丢了。'
    }
  }
  return {
    tone: 'ready',
    title: '按下和松开都有信号',
    hint:
      summary.pairs > 0 && summary.heldMs !== null
        ? `最近一次按住 ${formatHeld(summary.heldMs)}。按住不放再说一句，这里会跟着涨。`
        : '收到了按下，但还没收到松开——再按一次试试。'
  }
}
