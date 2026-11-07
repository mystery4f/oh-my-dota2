import * as React from 'react'
import type { TrainSnapshot } from '@shared/train/task'
import { judgeGvPreflight } from '@shared/train/preflight'
import type { TrainRunRecord } from '@shared/train/run'
import {
  GV_DEFAULTS,
  GV_VERSION_DEFAULT,
  GV_VERSION_INFO,
  type GvDatasetJudgement,
  type GvVersion
} from '@shared/train/gv'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, StatusPill } from '../components/primitives'
import { PreflightList, RunRow, Sparkline } from '../components/run-view'
import { formatDuration } from '../run-format'
import { selectClass } from '../components/select-class'

const GV_KINDS = new Set(['gv-gpt', 'gv-sovits'])

/**
 * 音色训练：GPT 语义腿与 SoVITS 声学腿各自开训，跑完注册成音色包。
 * 数据段只验收备料（四件套），打标注/降噪仍走 GPT-SoVITS 的 webui。
 */
export function VoiceTrainPage(): React.ReactElement {
  const [datasets, setDatasets] = React.useState<GvDatasetJudgement[]>([])
  const [runs, setRuns] = React.useState<TrainRunRecord[]>([])
  const [snapshot, setSnapshot] = React.useState<TrainSnapshot | null>(null)
  const [version, setVersion] = React.useState<GvVersion>(GV_VERSION_DEFAULT)
  const [name, setName] = React.useState('')
  const [targetExp, setTargetExp] = React.useState('')
  const [webui, setWebui] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    const [nextDatasets, nextRuns, nextSnapshot] = await Promise.all([
      window.api.trainGvDatasets(),
      window.api.trainRuns(),
      window.api.trainSnapshot()
    ])
    setDatasets(nextDatasets)
    setRuns(nextRuns.filter((run) => GV_KINDS.has(run.kind)))
    setSnapshot(nextSnapshot)
    setTargetExp((current) => current || nextDatasets[0]?.expName || '')
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(
    () =>
      window.api.onTrainState((next) => {
        setSnapshot(next)
        if (next.task && next.task.status !== 'running' && next.task.status !== 'preparing') void refresh()
      }),
    [refresh]
  )

  const task = snapshot?.task ?? null
  const taskRunning = task !== null && (task.status === 'running' || task.status === 'preparing' || task.status === 'stopping')
  const gvRuns = runs

  // 体检看的是「当前选中的实验」：换实验就在上面的数据行里选它，别让人猜在看谁。
  const preflight = React.useMemo(() => {
    const demo = datasets.find((dataset) => dataset.expName === targetExp)
    if (!demo) return []
    return judgeGvPreflight({
      expName: demo.expName,
      missing: demo.missing,
      gptTrained: runs.some((run) => run.kind === 'gv-gpt' && run.experiment === demo.expName && run.status !== 'failed'),
      sovitsTrained: runs.some(
        (run) => run.kind === 'gv-sovits' && run.experiment === demo.expName && run.status !== 'failed'
      )
    })
  }, [datasets, runs, targetExp])

  const act = async (label: string, action: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(label)
    setNote(`${label}…`)
    try {
      setNote(await action())
    } catch (err) {
      setNote(`${label}失败：${String(err)}`)
    } finally {
      setBusy('')
      await refresh()
    }
  }

  return (
    <>
      <Panel>
        <Group
          label="数据"
          action={
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              刷新
            </Button>
          }
        >
          <Row label="训练版本" hint="与底模成套：换版本等于换一套底模和权重目录">
            <select
              className={selectClass}
              value={version}
              onChange={(event) => setVersion(event.target.value as GvVersion)}
              aria-label="训练版本"
            >
              {(Object.keys(GV_VERSION_INFO) as GvVersion[]).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </Row>
          {datasets.length === 0 ? (
            <Row
              label="实验"
              hint="没扫到实验：先用 webui 跑完 1abc 三步（切音频、打标注、提特征），目录会出现在 logs/ 下"
            />
          ) : (
            datasets.map((dataset) => {
              const trained = gvRuns.filter((run) => run.experiment === dataset.expName)
              return (
                <Row
                  key={dataset.expName}
                  label={dataset.expName}
                  hint={
                    dataset.ready
                      ? `备料齐全 · 已训 ${trained.length} 次`
                      : `缺 ${dataset.missing.join('、')}`
                  }
                >
                  <StatusPill tone={dataset.ready ? 'ready' : 'warn'}>
                    {dataset.ready ? '可开训' : '缺备料'}
                  </StatusPill>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!dataset.ready || taskRunning || Boolean(busy)}
                    onClick={() =>
                      void act('GPT 腿', async () => {
                        const result = await window.api.trainStart({
                          kind: 'gv-gpt',
                          dataset: dataset.expName,
                          gv: { version, ...GV_DEFAULTS['gv-gpt'] }
                        })
                        return result.ok ? '已开训 GPT 腿' : `开训失败：${result.error ?? '未知错误'}`
                      })
                    }
                  >
                    GPT 腿
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!dataset.ready || taskRunning || Boolean(busy)}
                    onClick={() =>
                      void act('SoVITS 腿', async () => {
                        const result = await window.api.trainStart({
                          kind: 'gv-sovits',
                          dataset: dataset.expName,
                          gv: { version, ...GV_DEFAULTS['gv-sovits'] }
                        })
                        return result.ok ? '已开训 SoVITS 腿' : `开训失败：${result.error ?? '未知错误'}`
                      })
                    }
                  >
                    SoVITS 腿
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setTargetExp(dataset.expName)
                      setName(dataset.expName)
                    }}
                  >
                    选它注册
                  </Button>
                </Row>
              )
            })
          )}
          <Row label="webui" hint={note || '打标注 / 降噪 / 切音频都在 webui 里做，做完回这里刷新'}>
            <StatusPill tone={webui ? 'ready' : 'idle'}>{webui ? '已开' : '未开'}</StatusPill>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void act('webui', async () => {
                  const result = await window.api.trainGvWebui({ open: !webui })
                  setWebui(result.running)
                  return result.ok ? (result.running ? 'webui 已启动' : 'webui 已关') : `webui 失败：${result.error ?? '未知错误'}`
                })
              }
            >
              {webui ? '关闭 webui' : '打开 webui'}
            </Button>
          </Row>
        </Group>
      </Panel>

      <Panel>
        <Group label="运行">
          <PreflightList items={preflight} />
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
          {gvRuns.length === 0 ? (
            <Row label="训练记录" hint="还没有记录：开一次训就会在磁盘上留一条" />
          ) : (
            gvRuns.map((run) => (
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
            label="注册为音色包"
            hint={
              note ||
              (targetExp
                ? `把 ${targetExp} 训好的权重与参考音频登记成一个可选音色`
                : '先选一个训练好的实验')
            }
          >
            <select
              className={selectClass}
              value={targetExp}
              onChange={(event) => setTargetExp(event.target.value)}
              aria-label="注册的实验"
            >
              {datasets.map((dataset) => (
                <option key={dataset.expName} value={dataset.expName}>
                  {dataset.expName}
                </option>
              ))}
            </select>
            <input
              className={selectClass}
              placeholder="音色名"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              size="sm"
              disabled={Boolean(busy) || !targetExp || name.trim() === ''}
              onClick={() =>
                void act('注册', async () => {
                  const result = await window.api.trainGvRegister({
                    expName: targetExp,
                    version,
                    name: name.trim()
                  })
                  return result.ok ? `已注册音色「${name.trim()}」，去朗读页选它` : `注册失败：${result.error ?? '未知错误'}`
                })
              }
            >
              注册
            </Button>
          </Row>
          <Row
            label="训练产物位置"
            hint={targetExp ? `logs/${targetExp}/logs_s1_v2 · logs_s2_v2 · 权重在 GPT_weights_*/SoVITS_weights_*` : '—'}
          >
            <StatusPill tone="idle">训练目录</StatusPill>
          </Row>
        </Group>
      </Panel>
    </>
  )
}
