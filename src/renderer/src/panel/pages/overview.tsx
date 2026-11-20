import { useEffect, useState } from 'react'
import type {
  AppSettings,
  CaptureStatus,
  HotkeysResult,
  OverlayStatus,
  TranslatorStatus
} from '@shared/ipc'

import type { FirstRunReport, FirstRunStep } from '@shared/first-run'
import type { SectionId } from '../sections'
import { Button } from '@/components/ui/button'
import { CollapsibleGroup, Group, Row, StatusPill, Panel } from '../components/primitives'

/** 主进程一广播就会被真值覆盖，这里只负责不要闪。 */
const EMPTY_OVERLAY: OverlayStatus = {
  visible: false,
  textMode: 'translated',
  panelOpen: false,
  quickPhrases: [],
  locked: true,
  collapsed: false,
  readAloud: false,
  opacity: 0.34,
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
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const [nextSettings, nextCapture, nextTranslator, nextHotkeys, nextFirstRun] = await Promise.all([
      window.api.getSettings(),
      window.api.captureStatus(),
      window.api.translatorStatus(),
      window.api.getHotkeys(),
      window.api.firstRunReport()
    ])
    setSettings(nextSettings)
    setCapture(nextCapture)
    setTranslator(nextTranslator)
    setHotkeys(nextHotkeys)
    setFirstRun(nextFirstRun)
  }

  useEffect(() => {
    void refresh()
    const offOverlay = window.api.onOverlayState(setOverlay)
    // 上手检查也要跟着刷：GSI 帧、下载进度、热键占用都是随时变的，
    // 不刷就会出现「面板说还没进游戏，其实刚打了一局」。
    const timer = window.setInterval(() => {
      void window.api.captureStatus().then(setCapture)
      void window.api.translatorStatus().then(setTranslator)
      void window.api.firstRunReport().then(setFirstRun)
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

  const rejected = (hotkeys?.actions ?? []).filter((action) => action.verdict === 'rejected')

  return (
      <Panel>
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
            hint={capture ? `已收 ${capture.totalEntries} 条 · 上一句翻译 ${capture.lastTranslateMs === null ? '还没翻过' : `${capture.lastTranslateMs}ms`}` : undefined}
          >
            {capture?.running ? <StatusPill tone="ready">监听中</StatusPill> : <StatusPill tone="idle">已停止</StatusPill>}
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

        {translator?.lastFallback || capture?.lastError ? (
          <Group label="异常">
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
      </Panel>
  )
}
