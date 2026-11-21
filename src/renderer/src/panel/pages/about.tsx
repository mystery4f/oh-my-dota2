import { useEffect, useState } from 'react'
import type { LogBundleResult, UpdateState } from '@shared/ipc'
import type { BuildInfo } from '@shared/build-info'
import { ERROR_KIND_LABEL, errorsLine, type ErrorSummary } from '@shared/error-log'
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
  const [build, setBuild] = useState<BuildInfo | null>(null)
  const [bundleBusy, setBundleBusy] = useState(false)
  const [errors, setErrors] = useState<ErrorSummary | null>(null)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
    // 构建时间一次就够：产物 mtime 不会在自己跑着的时候改变（#113）。
    void window.api.buildInfo().then(setBuild)
    // 异常清单一次就够：主进程没接住的错误不会在这里自己冒出来，刷新靠重新进页面（P3）。
    void window.api.errorsView().then(setErrors)
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
        <Row label="构建时间" hint={build?.note ?? '正在读构建产物的时间'}>
          <span className="font-mono text-xs text-muted-foreground">
            {build?.stampMs ? new Date(build.stampMs).toLocaleString('zh-CN', { hour12: false }) : '…'}
          </span>
          {build?.stale ? <StatusPill tone="warn">源码更新了</StatusPill> : null}
        </Row>
      </Group>

      <Group label="诊断">
        <Row
          label="最近的错误"
          hint={errors === null ? '正在读本地异常清单（只在本机，不联网）' : errorsLine(errors)}
        >
          {errors === null ? null : (
            <StatusPill tone={errors.total === 0 ? 'ready' : errors.byKind.uncaught > 0 ? 'bad' : 'warn'}>
              {errors.total === 0 ? '没有' : `${errors.total} 条`}
            </StatusPill>
          )}
        </Row>
        {errors !== null && errors.groups.length > 0
          ? errors.groups.map((group) => (
              <Row
                key={`${group.kind}:${group.message}`}
                label={ERROR_KIND_LABEL[group.kind]}
                hint={`${group.count} 次 · 最近 ${group.newest.slice(11, 19)}${group.sample.context === null ? '' : ` · ${group.sample.context}`}`}
              >
                <span className="max-w-[420px] truncate font-mono text-xs text-muted-foreground">
                  {group.message}
                </span>
              </Row>
            ))
          : null}
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
