import { useEffect, useState } from 'react'
import type {
  AppSettings,
  CaptureStatus,
  HotkeysResult,
  OverlayStatus,
  TranslatorStatus
} from '@shared/ipc'

import type { FirstRunReport, FirstRunStep } from '@shared/first-run'
import type { EnvDeviceCounts, EnvReport } from '@shared/env-report'
import { envCounted } from '@shared/env-report'
import type { EnvState } from '@shared/env-report'
import type { GsiLibrariesView } from '@shared/gsi-lib'
import type { PatchWatchView } from '@shared/patch-watch'
import { libraryLabel } from '@shared/gsi-lib'
import type { VoiceOutReadiness } from '@shared/voice-out-readiness'
import { voiceOutReadinessVisible } from '@shared/voice-out-readiness'
import type { SectionId } from '../sections'
import { Button } from '@/components/ui/button'
import { CollapsibleGroup, Group, Row, StatusPill, Panel } from '../components/primitives'

/** 主进程一广播就会被真值覆盖，这里只负责不要闪。 */
const EMPTY_OVERLAY: OverlayStatus = {
  visible: false,
  textMode: 'translated',
  digest: false,
  panelOpen: false,
  quickPhrases: [],
  locked: true,
  collapsed: false,
  readAloud: false,
  opacity: 0.34,
  fontSize: 'normal',
  geometry: { x: 0, y: 0, width: 0, height: 0 },
  hint: null,
  hotkeys: {},
  voiceCaptureMode: 'hold'
}

/** 分位数比单次数字更能说明「为什么刚才那么慢」。 */
function formatLatency(status: TranslatorStatus | null): string {
  const latency = status?.latency
  if (!latency || latency.count === 0) return '暂无样本'
  const secs = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`)
  const parts = [`p50 ${secs(latency.p50)}`, `p90 ${secs(latency.p90)}`, `最大 ${secs(latency.max)}`]
  if (latency.direct > 0) parts.push(`直连 ${latency.direct}`)
  if (latency.timeout > 0) parts.push(`超时 ${latency.timeout}`)
  if (latency.error > 0) parts.push(`错误 ${latency.error}`)
  return parts.join(' · ')
}

/**
 * 六种状态只有四种颜色：颜色只表达「要不要动手」。ok 绿、pending 灰（等他动手或等游戏）、
 * blocked 红、unknown 灰（快照还没到，和 pending 一样不该抢眼）。
 */
const STEP_TONE: Record<FirstRunStep['state'], 'ready' | 'idle' | 'bad'> = {
  ok: 'ready',
  pending: 'idle',
  blocked: 'bad',
  unknown: 'idle'
}

const STEP_LABEL: Record<FirstRunStep['state'], string> = {
  ok: '有证据',
  pending: '待完成',
  blocked: '卡住了',
  unknown: '未知'
}
/** 这台机器的状态配色：warn 不算坏（琥珀），unknown 灰（没数据不是问题）。 */
const ENV_TONE: Record<EnvState, 'ready' | 'warn' | 'bad' | 'idle'> = {
  ok: 'ready',
  warn: 'warn',
  bad: 'bad',
  unknown: 'idle'
}

const ENV_STATE_LABEL: Record<EnvState, string> = {
  ok: '正常',
  warn: '偏紧',
  bad: '有问题',
  unknown: '测不到'
}

/**
 * 抬头三态（#175）：异常 > 未就绪 > 就绪。判据全来自现成的缝——
 * GSI 断流（gsi-stall）、声出就绪（voice-out-readiness）、这台机器（env-report）、上手检查。
 * 这一页只做映射与排序，不在这里算任何阈值：阈值搬进来就会出现「面板说坏了、探针说好的」。
 * env 的 warn 不降级（内存/磁盘偏紧常年存在，抬头永远发黄等于没提醒），但也不许消失：
 * 就绪态右侧带一句「另有 N 项提醒」。
 */
type HeadlineTone = 'bad' | 'warn' | 'ready'

type HeadlineAction =
  | { kind: 'rewrite-cfg'; label: string }
  | { kind: 'recheck'; label: string }
  | { kind: 'start-service'; label: string }
  | { kind: 'open-packs'; label: string }
  | { kind: 'machine-check'; label: string }
  | { kind: 'first-run'; label: string }

interface Headline {
  tone: HeadlineTone
  title: string
  hint: string
  action: HeadlineAction | null
  /** 就绪态还要提醒几项（env 的 warn），0 表示真的没什么可说。 */
  remind: number
}

interface HeadlineInput {
  stalled: boolean
  lastFallback: string | null
  captureError: string | null
  rejectedHotkeys: number
  readinessVisible: boolean
  readiness: VoiceOutReadiness | null
  envBad: readonly string[]
  envWarn: number
  firstRunOpen: number
}

const HEADLINE_LABEL: Record<HeadlineTone, string> = {
  bad: '有异常',
  warn: '未就绪',
  ready: '一切就绪'
}

function judgeHeadline(input: HeadlineInput): Headline {
  // 断流是唯一会写盘的主操作：重写 cfg 只让「重启 Dota」真的能连上，它不会自愈。
  if (input.stalled)
    return {
      tone: 'bad',
      title: 'GSI 断流了：Dota 那一侧要重启',
      hint: '改 cfg 只能让重启之后真的连上；运行中的游戏不重读配置，这一条任何应用都自愈不了。',
      action: { kind: 'rewrite-cfg', label: '重写 GSI 配置并重新检查' },
      remind: 0
    }
  if (input.rejectedHotkeys > 0)
    return {
      tone: 'bad',
      title: `有 ${input.rejectedHotkeys} 个热键被别的程序占着`,
      hint: '被占的键按下去没反应：在「热键」里换一个，或关掉占着它的程序。',
      action: { kind: 'recheck', label: '重新检查' },
      remind: 0
    }
  if (input.captureError !== null)
    return {
      tone: 'bad',
      title: '对局正文抓取报错',
      hint: input.captureError,
      action: { kind: 'recheck', label: '重新检查' },
      remind: 0
    }
  if (input.lastFallback !== null)
    return {
      tone: 'bad',
      title: '这一句改走了单次直连',
      hint: '偶发可忽略；连续出现说明会话层连不上，去「翻译引擎」页看。',
      action: { kind: 'recheck', label: '重新检查' },
      remind: 0
    }
  if (input.readinessVisible && input.readiness !== null && !input.readiness.ready) {
    const action: HeadlineAction | null =
      input.readiness.action === 'start-service'
        ? { kind: 'start-service', label: '启动服务' }
        : input.readiness.action === null
          ? null
          : { kind: 'open-packs', label: '去装齐…' }
    return {
      tone: 'warn',
      title: '声出还差一环',
      hint: input.readiness.line,
      action,
      remind: 0
    }
  }
  if (input.envBad.length > 0)
    return {
      tone: 'warn',
      title: `这台机器有 ${input.envBad.length} 项不达标（${input.envBad.join('、')}）`,
      hint: '识别、训练、出声都靠这几项——先看「这台机器」那六行再决定要不要紧。',
      action: { kind: 'machine-check', label: '去这台机器看哪一行' },
      remind: 0
    }
  if (input.firstRunOpen > 0)
    return {
      tone: 'warn',
      title: `上手还差 ${input.firstRunOpen} 步`,
      hint: '从空数据目录到第一局还有没收下的证据，往下看「上手检查」。',
      action: { kind: 'first-run', label: '看还差哪几步' },
      remind: 0
    }
  return {
    tone: 'ready',
    title: '一切就绪：模型、正文、浮层、热键都在位',
    hint: '对局里按热键就能用；这一页只在有东西变了的时候值得看。',
    action: null,
    remind: input.envWarn
  }
}
/**
 * 总览只回答一个问题：现在有没有东西坏了。
 * 四条链路 + 上手检查 + 被占用的热键；其余设置一律不在这一页重复。
 * 上手检查那一段是给新用户一个人看的一条链：空数据目录到第一局，六步各自带证据。
 */
export function OverviewPage({ onNavigate }: { onNavigate: (id: SectionId) => void }): React.ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [capture, setCapture] = useState<CaptureStatus | null>(null)
  const [translator, setTranslator] = useState<TranslatorStatus | null>(null)
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY)
  const [hotkeys, setHotkeys] = useState<HotkeysResult | null>(null)
  const [firstRun, setFirstRun] = useState<FirstRunReport | null>(null)
  const [env, setEnv] = useState<EnvReport | null>(null)
  const [envBusy, setEnvBusy] = useState(false)
  const [libs, setLibs] = useState<GsiLibrariesView | null>(null)
  const [libPick, setLibPick] = useState('')
  const [libBusy, setLibBusy] = useState(false)
  const [libNote, setLibNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [readiness, setReadiness] = useState<VoiceOutReadiness | null>(null)
  const [cfgFact, setCfgFact] = useState<string | null>(null)
  const [headBusy, setHeadBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const [nextSettings, nextCapture, nextTranslator, nextHotkeys, nextFirstRun, nextReadiness] =
      await Promise.all([
        window.api.getSettings(),
        window.api.captureStatus(),
        window.api.translatorStatus(),
        window.api.getHotkeys(),
        window.api.firstRunReport(),
        window.api.voiceOutReadiness().catch(() => null)
      ])
    setSettings(nextSettings)
    setCapture(nextCapture)
    setTranslator(nextTranslator)
    setHotkeys(nextHotkeys)
    setFirstRun(nextFirstRun)
    setReadiness(nextReadiness)
  }

  useEffect(() => {
    void refresh()
    void runEnv()
    const offOverlay = window.api.onOverlayState(setOverlay)
    // 上手检查也要跟着刷：GSI 帧、下载进度、热键占用都是随时变的，
    // 不刷就会出现「面板说还没进游戏，其实刚打了一局」。
    const timer = window.setInterval(() => {
      void window.api.captureStatus().then(setCapture)
      void window.api.translatorStatus().then(setTranslator)
      void window.api.firstRunReport().then(setFirstRun)
      void window.api.voiceOutReadiness().then(setReadiness)
    }, 3000)
    return () => {
      offOverlay()
      window.clearInterval(timer)
    }
  }, [])

  /**
   * 上手检查那一步的按钮：能做就当场做（真连一次、开始下载），
   * 做不了的只是换一页去填（Key / 热键 / 模型目录），绝不在这一页重复别处的设置。
   */
  const runStep = async (step: FirstRunStep): Promise<void> => {
    if (step.action === null) return
    if (step.action === 'open-engine') return onNavigate('engine')
    if (step.action === 'open-asr') return onNavigate('asr')
    if (step.action === 'open-hotkeys') return onNavigate('hotkeys')
    setBusy(true)
    try {
      if (step.action === 'test-provider') {
        const current = settings ?? (await window.api.getSettings())
        await window.api.testProvider(current.provider)
      } else {
        await window.api.asrDownload()
      }
      setFirstRun(await window.api.firstRunReport())
    } finally {
      setBusy(false)
    }
  }

  // 补丁巡检：进总览时读一次，没有缺口就什么都不显示（只有「有东西没读过」时才占一行）。
  const [patch, setPatch] = useState<PatchWatchView | null>(null)
  useEffect(() => {
    void window.api
      .patchWatch()
      .then(setPatch)
      .catch(() => setPatch(null))
  }, [])

  /** 「这台机器」只在进总览时测一次 + 手动刷新（pm 定的口径，不加后台轮询）。 */
  const runEnv = async (): Promise<void> => {
    setEnvBusy(true)
    try {
      const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
      const counts: EnvDeviceCounts = {
        micCount: all.filter((d) => d.kind === 'audioinput').length,
        speakerCount: all.filter((d) => d.kind === 'audiooutput').length
      }
      const [report, libraries] = await Promise.all([
        window.api.envReport(counts),
        window.api.gsiLibraries().catch(() => null)
      ])
      setEnv(report)
      setLibs(libraries)
      setLibPick(libraries?.chosen ?? '')
    } finally {
      setEnvBusy(false)
    }
  }

  /** #78：把选中的库记住并立刻重写 cfg；失败把原因摆出来，不假装成功。 */
  const saveLibrary = async (): Promise<void> => {
    setLibBusy(true)
    try {
      const result = await window.api.gsiSetLibrary(libPick)
      setLibNote(result.ok ? `已写进：${result.path ?? '（路径未知）'}` : (result.error ?? '保存失败'))
      if (result.ok) await runEnv()
    } finally {
      setLibBusy(false)
    }
  }

  const rejected = (hotkeys?.actions ?? []).filter((action) => action.verdict === 'rejected')

  // 抬头（#175）：只做映射与排序，判据全部来自现成的缝。
  const envBad = (env?.rows ?? []).filter((row) => row.state === 'bad').map((row) => row.label)
  const envWarn = (env?.rows ?? []).filter((row) => row.state === 'warn').length
  const headline = judgeHeadline({
    stalled: capture?.gsi?.stall.state === 'stalled',
    lastFallback: translator?.lastFallback ?? null,
    captureError: capture?.lastError ?? null,
    rejectedHotkeys: rejected.length,
    readinessVisible: voiceOutReadinessVisible(settings?.ttsOutEngine),
    readiness,
    envBad,
    envWarn,
    firstRunOpen: firstRun?.open ?? 0
  })

  const scrollTo = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /**
   * 抬头的主操作必须真做事，不是改本地 state（#167 立的规矩）：
   * 断流 → 真的重写 cfg；其它异常 → 真的重读状态；声出缺环 → 真的启服务或把人送到音色包；
   * 环境/上手检查 → 只是把人滚到那一段（那一段才是有证据的地方）。
   */
  const runHeadline = async (action: HeadlineAction): Promise<void> => {
    if (action.kind === 'machine-check') return scrollTo('machine-check')
    if (action.kind === 'first-run') return scrollTo('first-run')
    if (action.kind === 'open-packs') return onNavigate('packs')
    setHeadBusy(true)
    try {
      if (action.kind === 'rewrite-cfg') {
        const result = await window.api.gsiSetLibrary(libs?.chosen ?? '')
        setCfgFact(
          result.ok
            ? `cfg 已重写 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}，游戏需重启才生效`
            : `cfg 没写成：${result.error ?? '原因不明'}——这一条只能重启 Dota 解决`
        )
      }
      if (action.kind === 'start-service') await window.api.sovitsStartServer()
      await refresh()
      await runEnv()
    } finally {
      setHeadBusy(false)
    }
  }

  return (
      <Panel>
        <Row label="当前状态" stacked hint={headline.hint}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={headline.tone}>{HEADLINE_LABEL[headline.tone]}</StatusPill>
            <span className="min-w-0 flex-1 text-sm">{headline.title}</span>
            {headline.action === null ? null : (
              <Button
                className="shrink-0"
                onClick={() => void runHeadline(headline.action as HeadlineAction)}
                disabled={headBusy}
              >
                {headline.action.label}
              </Button>
            )}
            {headline.tone === 'ready' && headline.remind > 0 ? (
              <button
                type="button"
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => scrollTo('machine-check')}
              >
                另有 {headline.remind} 项提醒
              </button>
            ) : null}
          </div>
          {cfgFact === null ? null : (
            <div className="text-xs text-muted-foreground">{cfgFact}</div>
          )}
        </Row>
        <Group label="四条链路">
          <Row
            label="模型服务"
            hint={settings ? `${settings.provider.id} · ${settings.provider.model}` : '读取中…'}
          >
            {translator?.lastFallback ? (
              <StatusPill tone="warn">回退直连</StatusPill>
            ) : (
              <StatusPill tone="ready">会话在位</StatusPill>
            )}
          </Row>
          <Row
            label="对局正文"
            hint={
              capture
                ? `已收 ${capture.totalEntries} 条 · 上一句翻译 ${capture.lastTranslateMs === null ? '还没翻过' : `${capture.lastTranslateMs}ms`}`
                : undefined
            }
          >
            {capture?.running ? <StatusPill tone="ready">监听中</StatusPill> : <StatusPill tone="idle">已停止</StatusPill>}
            {/* 断流时不重复一句话两遍：这里只把「几秒前还收到过帧」亮出来（正常时也是证据），
                真正要动作的告警在下面「异常」组里。 */}
            {capture?.gsi?.stall.state === 'stalled' ? (
              <StatusPill tone="bad">断流</StatusPill>
            ) : capture?.gsi?.stall.since ? (
              <span className="text-xs text-muted-foreground">{capture.gsi.stall.since}</span>
            ) : null}
          </Row>
          <Row label="浮层" hint={overlay.geometry.width > 0 ? `${overlay.geometry.width}×${overlay.geometry.height}` : undefined}>
            {overlay.visible ? <StatusPill tone="ready">显示中</StatusPill> : <StatusPill tone="idle">已隐藏</StatusPill>}
            {overlay.locked ? null : <StatusPill tone="warn">可编辑</StatusPill>}
            {overlay.collapsed ? <StatusPill tone="idle">已收起</StatusPill> : null}
          </Row>
          <Row label="翻译延迟" hint={formatLatency(translator)}>
            {translator?.latency.p50 != null && translator.latency.p50 > 3000 ? (
              <StatusPill tone="warn">偏慢</StatusPill>
            ) : translator?.latency.count ? (
              <StatusPill tone="ready">正常</StatusPill>
            ) : (
              <StatusPill tone="idle">暂无样本</StatusPill>
            )}
          </Row>
        </Group>

        {translator?.lastFallback || capture?.lastError || capture?.gsi?.stall.state === 'stalled' ? (
          <Group label="异常">
            {capture?.gsi?.stall.state === 'stalled' ? (
              <Row
                label="GSI 断流"
                stacked
                hint="运行中的 Dota 不会重读 GSI 配置：这一条只能诊断，任何应用都改不了它——所以解决办法只有重启游戏"
              >
                <span className="text-sm text-amber-300">{capture.gsi.stall.warning}</span>
              </Row>
            ) : null}
            {translator?.lastFallback ? (
              <Row label="会话层回退直连" stacked hint="会话请求失败，这一句改走了单次直连——偶发可忽略，连续出现查「翻译引擎」页">
                <span className="text-sm text-amber-300">{translator.lastFallback}</span>
              </Row>
            ) : null}
            {capture?.lastError ? (
              <Row label="对局正文报错" stacked>
                <span className="text-sm text-destructive">{capture.lastError}</span>
              </Row>
            ) : null}
          </Group>
        ) : null}

        <div id="first-run">
        <Group label="上手检查">
          <Row
            label={firstRun ? `${firstRun.done}/${firstRun.steps.length} 步有证据` : '读取中…'}
            hint="从空数据目录到第一局：每一步都要能核对——路径、延迟、几秒前收到帧、哪个键被占"
            stacked
          >
            {firstRun === null ? (
              <span className="text-sm text-muted-foreground">正在读现状…</span>
            ) : (
              <div className="space-y-2">
                {firstRun.steps.map((step) => (
                  <div key={step.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <StatusPill tone={STEP_TONE[step.state]}>
                        {STEP_LABEL[step.state]}
                      </StatusPill>
                      <span className="w-20 shrink-0 text-sm text-muted-foreground">{step.label}</span>
                      <span className="min-w-0 flex-1 break-all text-sm">{step.evidence}</span>
                      {step.action === null ? null : (
                        <Button
                          className="shrink-0"
                          onClick={() => void runStep(step)}
                          disabled={busy}
                        >
                          {step.actionLabel}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {firstRun.open === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    六步齐了：进对局后这几行会自己变成「游戏连上」的证据。
                  </span>
                ) : null}
              </div>
            )}
          </Row>
        </Group>
        </div>
        <div id="machine-check">
        <Group label="这台机器">
          <Row
            label={env ? `${envCounted(env)}/6 行有数据` : '正在读现状…'}
            hint="识别/训练吃 CPU 和内存，模型和产物占磁盘，正文走 32123 端口，对讲靠设备：哪一行出事，先看这一页。"
            stacked
          >
            {env === null ? (
              <span className="text-sm text-muted-foreground">正在读现状…</span>
            ) : (
              <div className="space-y-2">
                {env.rows.map((row) => (
                  <div key={row.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <StatusPill tone={ENV_TONE[row.state]}>
                        {ENV_STATE_LABEL[row.state]}
                      </StatusPill>
                      <span className="w-20 shrink-0 text-sm text-muted-foreground">{row.label}</span>
                      <span className="min-w-0 flex-1 break-all text-sm">{row.value ?? row.gap ?? '—'}</span>
                    </div>
                    <div className="pl-[5.5rem] text-xs text-muted-foreground">
                      {row.value === null ? `${row.gap}；为什么在意：${row.why}` : row.why}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {libs !== null && (libs.roots.length > 1 || libs.resolve.missing) ? (
              <div className="space-y-2 border-t border-border/40 pt-2">
                <div className="flex items-center gap-2">
                  <StatusPill tone={libs.resolve.missing ? 'bad' : 'ready'}>
                    {libs.resolve.missing ? '路径缺失' : '已选定'}
                  </StatusPill>
                  <span className="w-20 shrink-0 text-sm text-muted-foreground">Steam 库</span>
                  <select
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                    value={libPick}
                    onChange={(event) => setLibPick(event.target.value)}
                  >
                    <option value="">自动（第一个装了 Dota 的库）</option>
                    {libs.roots.map((info) => (
                      <option key={info.root} value={info.root}>
                        {libraryLabel(info)}
                      </option>
                    ))}
                  </select>
                  <Button className="shrink-0" onClick={() => void saveLibrary()} disabled={libBusy}>
                    {libBusy ? '写入…' : '用这个库'}
                  </Button>
                </div>
                <div className="pl-[5.5rem] text-xs text-muted-foreground">
                  {libs.resolve.missing
                    ? `上次选的库不在了：${libs.chosen}——重选一个，或选「自动」。`
                    : 'Dota 只在启动时读 GSI 配置：换库后要重启游戏才会生效。'}
                </div>
                {libNote === null ? null : <div className="pl-[5.5rem] text-xs text-amber-300">{libNote}</div>}
              </div>
            ) : null}
            <div className="pt-2">
              <Button
                className="shrink-0"
                onClick={() => void runEnv()}
                disabled={envBusy}
              >
                {envBusy ? '测一次…' : '再测一次'}
              </Button>
            </div>
          </Row>
        </Group>
        </div>

        <CollapsibleGroup id="overview.hotkeys" label="热键一览" defaultOpen={rejected.length > 0}>
          {(hotkeys?.actions ?? []).map((action) => (
            <Row key={action.id} label={action.label}>
              <span className={action.verdict === 'rejected' ? 'font-mono text-sm text-destructive' : 'font-mono text-sm'}>
                {action.display || '未绑定'}
              </span>
              {action.verdict === 'rejected' ? <StatusPill tone="bad">被占用</StatusPill> : null}
            </Row>
          ))}
        </CollapsibleGroup>
        {/* 补丁巡检（#131）：沉到全页最后——它是给开发看的，不是给用户看的（#175）。 */}
        {patch !== null && patch.line !== null ? (
          <Group label="代码适配">
            <Row label="游戏发来了新东西" hint={patch.line} stacked />
          </Group>
        ) : null}
      </Panel>
  )
}
