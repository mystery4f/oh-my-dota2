import { useEffect, useState } from 'react'
import type { LogBundleResult, UpdateState } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, StatusPill } from '../components/primitives'

/**
 * 关于页：版本 + 更新 + 文档指引。
 * 旧版的里程碑清单删掉了（用户拍板），完整计划在 docs/PLAN.md。
 */

const STATUS_TEXT: Record<UpdateState['status'], string> = {
  idle: '未检查',
  checking: '检查中',
  downloading: '下载中',
  ready: '有新版本',
  none: '已是最新',
  error: '检查失败',
  dev: '开发模式'
}

export function AboutPage(): React.ReactElement {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [bundle, setBundle] = useState<LogBundleResult | null>(null)
  const [bundleBusy, setBundleBusy] = useState(false)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
    return window.api.onUpdateStatus(setState)
  }, [])

  const ready = state?.status === 'ready'

  const run = async (): Promise<void> => {
    if (ready) {
      await window.api.updateInstall()
      return
    }
    setBusy(true)
    setState(await window.api.updateCheck())
    setBusy(false)
  }

  // 诊断包：一键把 logs/ 里的证据打成一个 zip，默认已脱敏。缺的日志照实说，不是失败。
  const exportBundle = async (): Promise<void> => {
    setBundleBusy(true)
    setBundle(await window.api.logBundleExport())
    setBundleBusy(false)
  }

  const bundleHint = ((): string => {
    if (!bundle) return '把 logs/ 里的证据打成一个 zip（昵称与设备 id 已脱敏），发出去排查用'
    if (!bundle.ok) return bundle.error ?? '导出失败'
    const size = bundle.bytes >= 1024 ? `${Math.round(bundle.bytes / 1024)} KB` : `${bundle.bytes} B`
    const missing = bundle.missing.length > 0 ? ` · 缺 ${bundle.missing.join('、')}` : ''
    return `${bundle.files} 份日志 · ${size} · ${bundle.path}${missing}`
  })()

  return (
    <Panel>
      <Group label="版本">
        <Row label="当前版本" hint={state?.channel === 'nightly' ? 'Nightly 线只跟 Nightly 更新' : '稳定线只跟正式版更新'}>
          <span className="font-mono text-sm">v{version || '…'}</span>
          {state?.channel === 'nightly' ? <StatusPill tone="warn">Nightly</StatusPill> : null}
        </Row>
        <Row
          label="更新"
          hint={state?.message ?? '启动 8 秒后自动检查一次；这里手动检查（仅打包版，开发模式不检查）'}
        >
          <Button variant={ready ? 'default' : 'outline'} size="sm" disabled={busy} onClick={() => void run()}>
            {ready ? '重启并更新' : busy ? '检查中…' : '检查更新'}
          </Button>
          {state ? (
            <StatusPill tone={state.status === 'error' ? 'bad' : state.status === 'ready' ? 'warn' : 'idle'}>
              {STATUS_TEXT[state.status]}
              {state.status === 'downloading' ? ` ${state.percent ?? 0}%` : ''}
            </StatusPill>
          ) : null}
        </Row>
      </Group>

      <Group label="诊断">
        <Row label="导出诊断包" hint={bundleHint}>
          <Button variant="outline" size="sm" disabled={bundleBusy} onClick={() => void exportBundle()}>
            {bundleBusy ? '打包中…' : '导出'}
          </Button>
          {bundle ? <StatusPill tone={bundle.ok ? (bundle.missing.length > 0 ? 'warn' : 'ready') : 'bad'}>{bundle.ok ? '已导出' : '失败'}</StatusPill> : null}
        </Row>
      </Group>
      <Group label="文档">
        <Row label="设计文档" hint="路由决策与整体架构">
          <span className="text-xs text-muted-foreground">docs/DESIGN.md</span>
        </Row>
        <Row label="排障手册" hint="症状 → 原因 → 修法（中文）">
          <span className="text-xs text-muted-foreground">docs/ACCEPTANCE.md · docs/NOTES.md</span>
        </Row>
        <Row label="术语表" hint="对讲 / 声出 / 朗读 这些词的定义">
          <span className="text-xs text-muted-foreground">GLOSSARY.md</span>
        </Row>
      </Group>
    </Panel>
  )
}
