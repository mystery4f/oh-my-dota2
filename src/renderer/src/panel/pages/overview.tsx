import { useEffect, useState } from 'react'
import { errorMessage } from '@shared/errors'
import type {
  AppSettings,
  CaptureStatus,
  HotkeysResult,
  OverlayStatus,
  TranslatorStatus
} from '@shared/ipc'

/** 自检结果的一行：真连了一次服务，成功就带延迟。 */
type CheckRow = { label: string; ok: boolean; detail: string }
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
 * 总览只回答一个问题：现在有没有东西坏了。
 * 四条链路 + 被占用的热键 + 一键自检；其余设置一律不在这一页重复。
 */
export function OverviewPage(): React.ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [capture, setCapture] = useState<CaptureStatus | null>(null)
  const [translator, setTranslator] = useState<TranslatorStatus | null>(null)
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY)
  const [hotkeys, setHotkeys] = useState<HotkeysResult | null>(null)
  const [rows, setRows] = useState<CheckRow[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const [nextSettings, nextCapture, nextTranslator, nextHotkeys] = await Promise.all([
      window.api.getSettings(),
      window.api.captureStatus(),
      window.api.translatorStatus(),
      window.api.getHotkeys()
    ])
    setSettings(nextSettings)
    setCapture(nextCapture)
    setTranslator(nextTranslator)
    setHotkeys(nextHotkeys)
  }

  useEffect(() => {
    void refresh()
    const offOverlay = window.api.onOverlayState(setOverlay)
    const timer = window.setInterval(() => {
      void window.api.captureStatus().then(setCapture)
      void window.api.translatorStatus().then(setTranslator)
    }, 3000)
    return () => {
      offOverlay()
      window.clearInterval(timer)
    }
  }, [])

  const selfCheck = async (): Promise<void> => {
    setBusy(true)
    const next: CheckRow[] = []
    try {
      const current = settings ?? (await window.api.getSettings())
      try {
        const result = await window.api.testProvider(current.provider)
        next.push({
          label: '模型服务',
          ok: result.ok,
          detail: `${result.ok ? `${result.latencyMs ?? 0} ms` : result.message} · ${current.provider.model}`
        })
      } catch (err) {
        next.push({ label: '模型服务', ok: false, detail: errorMessage(err) })
      }
      const captureStatus = await window.api.captureStatus()
      next.push({
        label: '对局正文',
        ok: captureStatus.running,
        detail: captureStatus.running ? `监听中 · ${captureStatus.totalEntries} 条` : '已停止'
      })
      setRows(next)
      await refresh()
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

        <Group label="自检">
          <Row
            label="模型服务 + 对局正文"
            hint={rows ? undefined : '点一下真连一次模型、读一次监听状态'}
            stacked={Boolean(rows)}
          >
            <Button onClick={() => void selfCheck()} disabled={busy}>
              {busy ? '检查中…' : '一键自检'}
            </Button>
            {rows ? (
              <div className="mt-2 space-y-1">
                {rows.map((row) => (
                  <div key={row.label} className="flex items-center gap-2 text-sm">
                    <StatusPill tone={row.ok ? 'ready' : 'bad'}>{row.ok ? '通过' : '失败'}</StatusPill>
                    <span className="w-28 shrink-0 text-muted-foreground">{row.label}</span>
                    <span className="truncate">{row.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
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
