import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/ipc'
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
