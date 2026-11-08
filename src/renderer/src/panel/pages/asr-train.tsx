import * as React from 'react'
import type { FtRecInfo, FtScriptState } from '@shared/ipc'
import type { AsrFtStatusResult } from '@shared/train/asr-ft'
import type { TrainSnapshot } from '@shared/train/task'
import { judgeAsrPreflight, preflightBlocks } from '@shared/train/preflight'
import type { TrainRunRecord } from '@shared/train/run'
import { recordingKey, takeLineId } from '@shared/train/recording'
import { normalizeLine } from '@shared/chat-line'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, StatusPill } from '../components/primitives'
import { PreflightList, RunRow, Sparkline } from '../components/run-view'
import { formatDuration } from '../run-format'
import { selectClass } from '../components/select-class'
import { useRecorder } from '../use-recorder'


/**
 * 识别训练：录读稿 → 打包数据集 → 微调 Qwen3-ASR → 应用。
 * 三段固定顺序（数据 / 运行 / 产物），开训体检只在运行段里出结论，不拦人看历史。
 */
export function AsrTrainPage(): React.ReactElement {
  const [script, setScript] = React.useState<FtScriptState | null>(null)
  const [recs, setRecs] = React.useState<Record<string, FtRecInfo>>({})
  const [status, setStatus] = React.useState<AsrFtStatusResult | null>(null)
  const [runs, setRuns] = React.useState<TrainRunRecord[]>([])
  const [snapshot, setSnapshot] = React.useState<TrainSnapshot | null>(null)
  const [groupId, setGroupId] = React.useState('')
  const [lineNo, setLineNo] = React.useState(1)
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState('')
  const [asrText, setAsrText] = React.useState('')
  const [packed, setPacked] = React.useState<{ train: number; eval: number } | null>(null)

  const groups = script?.groups ?? []
  const group = groups.find((item) => item.id === groupId) ?? groups[0] ?? null

  const refreshRecs = React.useCallback(async (): Promise<void> => {
    const list = await window.api.ftRecList()
    const next: Record<string, FtRecInfo> = {}
    for (const info of list) next[info.key] = info
    setRecs(next)
  }, [])

  const refreshRuns = React.useCallback(async (): Promise<void> => {
    setRuns(await window.api.trainRuns())
  }, [])

  const refreshStatus = React.useCallback(async (): Promise<void> => {
    setStatus(await window.api.ftAsrftStatus())
  }, [])

  React.useEffect(() => {
    void (async () => {
      const [nextScript, nextSnapshot] = await Promise.all([
        window.api.ftScriptRead(),
        window.api.trainSnapshot()
      ])
      setScript(nextScript)
      setSnapshot(nextSnapshot)
      if (nextScript.groups.length > 0) setGroupId((current) => current || nextScript.groups[0].id)
      await Promise.all([refreshRecs(), refreshStatus(), refreshRuns()])
    })()
  }, [refreshRecs, refreshRuns, refreshStatus])

  React.useEffect(() => {
    return window.api.onTrainState((next) => {
      setSnapshot(next)
      if (next.task?.status === 'running' || next.task?.status === 'preparing') return
      // 收场后记录与产物都变了：列表、环境、已训标记一起刷新。
      void refreshRuns()
      void refreshStatus()
      void refreshRecs()
    })
  }, [refreshRecs, refreshRuns, refreshStatus])

  const recorder = useRecorder(refreshRecs)

  React.useEffect(() => {
    if (group && !group.lines.some((line) => line.no === lineNo)) setLineNo(group.lines[0]?.no ?? 1)
  }, [group, lineNo])

  const task = snapshot?.task ?? null
  const taskRunning = task !== null && (task.status === 'running' || task.status === 'preparing' || task.status === 'stopping')

  const recordedLines = group ? group.lines.filter((line) => recs[recordingKey(group.id, group.mode, line.no)]) : []
  const activeRec = group ? recs[recordingKey(group.id, group.mode, lineNo)] : undefined
  const currentLine = group?.lines.find((line) => line.no === lineNo) ?? null
  const coverage = group && status ? status.coverage[group.id] : undefined

  // 体检是纯函数缝（shared/train/preflight）：页面只负责把事实喂进去，结论与文案都在一起测。
  const { preflight, blocks } = React.useMemo(() => {
    const items = judgeAsrPreflight({
      env: status?.env ?? { ok: false, gaps: ['状态还没读到'] },
      recordedLines: Object.keys(recs).length,
      packed,
      activeModel: Boolean(status?.swap.activeExists),
      resumeAvailable: runs.some((run) => run.kind === 'asr-ft' && run.status === 'trained'),
      vramNote: null
    })
    return { preflight: items, blocks: preflightBlocks(items) }
  }, [status, recs, packed, runs])

  const runAction = async (label: string, action: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(label)
    setNote(`${label}…`)
    try {
      setNote(await action())
    } catch (err) {
      setNote(`${label}失败：${String(err)}`)
    } finally {
      setBusy('')
      await Promise.all([refreshRecs(), refreshStatus(), refreshRuns()])
    }
  }

  return (
    <>
      <Panel>
        <Group
          label="数据"
          action={
            <Button size="sm" variant="ghost" onClick={() => void runAction('刷新', async () => '已刷新')}>
              刷新
            </Button>
          }
        >
          <Row
            label="录音"
            hint={
              group
                ? `${group.title} · 已录 ${recordedLines.length}/${group.lines.length} 句`
                : (script?.error ?? '读稿还没读出来')
            }
          >
            <select
              className={selectClass}
              value={group?.id ?? ''}
              onChange={(event) => setGroupId(event.target.value)}
              aria-label="录音组"
            >
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} {item.title}
                </option>
              ))}
            </select>
            {coverage ? (
              <StatusPill tone={coverage.stale > 0 ? 'warn' : 'ready'}>
                已训 {coverage.done}/{coverage.total}
              </StatusPill>
            ) : null}
          </Row>

          {group && group.mode === 'lines' ? (
            <Row label="句子" hint={currentLine ? currentLine.text : '这一组没有稿子'}>
              <div className="flex flex-wrap justify-end gap-1">
                {group.lines.map((line) => {
                  const has = recs[recordingKey(group.id, group.mode, line.no)]
                  return (
                    <Button
                      key={line.no}
                      size="sm"
                      variant={line.no === lineNo ? 'default' : has ? 'secondary' : 'ghost'}
                      onClick={() => setLineNo(line.no)}
                    >
                      {line.no}
                    </Button>
                  )
                })}
              </div>
            </Row>
          ) : null}

          <Row
            label="录制"
            hint={
              recorder.hint ||
              (activeRec
                ? `这条已录 ${(activeRec.durationMs / 1000).toFixed(1)}s，重录会覆盖`
                : '点录制开始，说完自动停')
            }
          >
            <Button
              size="sm"
              variant="outline"
              disabled={recorder.recording || !group || group.mode !== 'lines'}
              onClick={() => void recorder.begin({ group: group?.id ?? '', mode: group?.mode ?? 'lines', line: lineNo })}
            >
              录制
            </Button>
            <Button size="sm" variant="outline" disabled={!recorder.recording} onClick={() => void recorder.stop()}>
              停止
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!activeRec || !group}
              onClick={() =>
                void runAction('回放', async () => {
                  if (!group) return '没有选中组'
                  const bytes = await window.api.ftRecRead(group.id, takeLineId(group.mode, lineNo))
                  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }))
                  const audio = new Audio(url)
                  audio.addEventListener('ended', () => URL.revokeObjectURL(url))
                  void audio.play()
                  return '回放中'
                })
              }
            >
              回放
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!activeRec || !group}
              onClick={() =>
                void runAction('识别测试', async () => {
                  if (!group) return '没有选中组'
                  const result = await window.api.ftRecAsr(group.id, takeLineId(group.mode, lineNo))
                  setAsrText(result.ok ? result.text : (result.error ?? '未知错误'))
                  if (!result.ok) return `识别失败：${result.error ?? '未知错误'}`
                  const expected = currentLine?.text ?? ''
                  const match = expected !== '' && normalizeLine(expected) === normalizeLine(result.text)
                  return `${match ? '✓ 与稿子一致' : '✕ 与稿子不一致'}：${result.text}`
                })
              }
            >
              识别测试
            </Button>
          </Row>

          {asrText ? (
            <Row label="识别结果" hint={asrText}>
              <span className="text-xs text-muted-foreground">{asrText.length} 字</span>
            </Row>
          ) : null}

          <Row label="打包数据集" hint={note || '已录句子 × 稿子 → 训练/验证两份 jsonl，训练脚本直接吃'}>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() =>
                void runAction('打包', async () => {
                  const result = await window.api.ftDatasetPrepare()
                  if (result.ok) setPacked({ train: result.trainCount, eval: result.evalCount })
                  return result.ok
                    ? `已打包：训练 ${result.trainCount} 条 / 验证 ${result.evalCount} 条`
                    : `打包失败：${result.error ?? '未知错误'}`
                })
              }
            >
              打包
            </Button>
          </Row>
        </Group>
      </Panel>

      <Panel>
        <Group label="运行">
          <Row
            label={task ? `当前任务 · ${task.kind}` : '当前任务'}
            hint={
              task
                ? `${task.stage || '准备中'}｜${formatDuration((task.endedAt ?? Date.now()) - task.startedAt)}`
                : '没有正在跑的训练'
            }
          >
            {task ? (
              <>
                <StatusPill tone={task.status === 'failed' ? 'bad' : taskRunning ? 'warn' : 'ready'}>
                  {task.status === 'running' ? `${task.progress}%` : task.status}
                </StatusPill>
                <Button size="sm" variant="outline" disabled={!taskRunning} onClick={() => void window.api.trainStop()}>
                  停止
                </Button>
              </>
            ) : null}
          </Row>

          <PreflightList items={preflight} />

          <Row
            label="开训"
            hint={
              blocks.length > 0
                ? `先解决：${blocks.map((item) => item.label).join('、')}`
                : '轮数按录音量自动算，够 800 步就停'
            }
          >
            <Button
              size="sm"
              disabled={taskRunning || blocks.length > 0}
              onClick={() =>
                void runAction('开训', async () => {
                  const result = await window.api.trainStart({ kind: 'asr-ft', dataset: group?.id ?? 'asr-ft' })
                  return result.ok ? '已开训' : `开训失败：${result.error ?? '未知错误'}`
                })
              }
            >
              开始训练
            </Button>
          </Row>

          {runs.length === 0 ? (
            <Row label="训练记录" hint="还没有记录：跑一次就会在磁盘上留一条" />
          ) : (
            runs.map((run) => (
              <React.Fragment key={run.id}>
                <RunRow run={run} />
                <Sparkline run={run} />
              </React.Fragment>
            ))
          )}
        </Group>
      </Panel>

      <Panel>
        <Group label="产物">
          <Row
            label="生效模型"
            hint={
              status
                ? `回滚槽 ${status.swap.bakExists ? '有' : '无'} · 待应用 ${status.swap.nextExists ? '有' : '无'} · 最近导出 ${status.swap.lastExportDir ?? '无'}`
                : '正在读状态…'
            }
          >
            <StatusPill tone={status?.swap.activeExists ? 'ready' : 'warn'}>
              {status?.swap.activeExists ? '已就位' : '缺模型'}
            </StatusPill>
          </Row>
          <Row label="应用 / 回滚" hint="应用会把当前的模型挪进回滚槽，失败能退回来">
            <Button size="sm" variant="outline"
              disabled={Boolean(busy) || taskRunning}
              onClick={() =>
                void runAction('应用', async () => {
                  const result = await window.api.ftAsrftApply()
                  return result.ok ? '已应用新模型' : `应用失败：${result.error ?? '未知错误'}`
                })
              }
            >
              应用
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy) || taskRunning}
              onClick={() =>
                void runAction('回滚', async () => {
                  const result = await window.api.ftAsrftRollback()
                  return result.ok ? '已回滚' : `回滚失败：${result.error ?? '未知错误'}`
                })
              }
            >
              回滚
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy) || taskRunning}
              onClick={() =>
                void runAction('安装环境', async () => {
                  await window.api.ftAsrftInstall()
                  return '安装已开始，进度看"当前任务"'
                })
              }
            >
              安装环境
            </Button>
          </Row>
        </Group>
      </Panel>
    </>
  )
}
