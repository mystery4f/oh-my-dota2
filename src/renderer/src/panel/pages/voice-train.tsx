import * as React from 'react'
import type { TrainSnapshot } from '@shared/train/task'
import { judgeGvPreflight, preflightSummary } from '@shared/train/preflight'
import type { TrainRunRecord } from '@shared/train/run'
import {
  GV_LEGS,
  GV_VERSION_DEFAULT,
  GV_VERSION_INFO,
  type GvDatasetJudgement,
  type GvLegKind,
  type GvVersion
} from '@shared/train/gv'
import type { SovitsStatus, SovitsVoicePack } from '@shared/ipc'
import { machineEnvLine, machineEnvState, type MachineEnvReport } from '@shared/machine-env'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, StatusPill } from '../components/primitives'
import { RunRow, Sparkline } from '../components/run-view'
import { TrainTaskRow } from '../components/train-task-row'
import { useTrainConsole } from '../use-train-console'
import { selectClass } from '../components/select-class'

const GV_KINDS = new Set(['gv-gpt', 'gv-sovits'])
/** 默认先跑语义腿：SoVITS 的声学腿吃 GPT 腿训出来的权重，顺序反了等于白跑一次。 */
const DEFAULT_LEG: GvLegKind = 'gv-gpt'
/** 一条腿的「开不了」：一句话说清缺什么，第二句说清怎么修。 */
interface Blocker {
  pill: string
  text: string
  fix: string
}

/**
 * 音色训练：一页只回答一个问题——现在能不能开训，不能的话缺哪一样。
 *
 * 顺序按原型：能不能跑 → 数据 → 训练 → 产物。每块第一行说「现在是什么」，第二行才是控件。
 * 【为什么没有「环境三行」】GV 侧只有引擎包有没有装、实验备料齐不齐；Python / 依赖 / 显存是
 * ASR 微调那边的状态（`ftAsrftStatus().env`），搬到这一页就是把「口音微调环境」当音色训练的环境报，
 * 是假话（#178 认领时的 C1，pm 已确认另开票 #179）。假话比空缺更糟，所以这里只报真有的两件事。
 */
export function VoiceTrainPage(): React.ReactElement {
  const [datasets, setDatasets] = React.useState<GvDatasetJudgement[]>([])
  const [runs, setRuns] = React.useState<TrainRunRecord[]>([])
  const [version, setVersion] = React.useState<GvVersion>(GV_VERSION_DEFAULT)
  const [legKind, setLegKind] = React.useState<GvLegKind>(DEFAULT_LEG)
  const [name, setName] = React.useState('')
  const [targetExp, setTargetExp] = React.useState('')
  const [webui, setWebui] = React.useState(false)
  const [sovits, setSovits] = React.useState<SovitsStatus | null>(null)
  const [packs, setPacks] = React.useState<SovitsVoicePack[]>([])
  const [registered, setRegistered] = React.useState('')
  const [machine, setMachine] = React.useState<MachineEnvReport | null>(null)
  const [now, setNow] = React.useState(() => Date.now())

  const load = React.useCallback(async (): Promise<TrainSnapshot> => {
    const [nextDatasets, nextRuns, nextSnapshot, nextSovits, nextPacks] = await Promise.all([
      window.api.trainGvDatasets(),
      window.api.trainRuns(),
      window.api.trainSnapshot(),
      window.api.sovitsStatus(),
      window.api.sovitsVoicepacks()
    ])
    setDatasets(nextDatasets)
    setRuns(nextRuns.filter((run) => GV_KINDS.has(run.kind)))
    setTargetExp((current) => current || nextDatasets[0]?.expName || '')
    setSovits(nextSovits)
    setPacks(nextPacks)
    return nextSnapshot
  }, [])

  // 状态订阅、动作单飞与「当前任务」都归运行台；这里只剩收场后要刷新哪些列表。
  const { task, taskRunning, busy, note, reload, run: act } = useTrainConsole(load)

  // 已跑时间要在跑的那几分钟里自己走：只在有任务时挂 5 秒定时器，跑完就拆。
  React.useEffect(() => {
    if (!taskRunning) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [taskRunning])

  // #179：机器级三行进页面测一次（不轮询）。它答的是「这台机器」，不是某一步的进度。
  React.useEffect(() => {
    let alive = true
    void window.api
      .machineEnv()
      .then((report) => {
        if (alive) setMachine(report)
      })
      .catch(() => {
        if (alive) setMachine(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const dataset = React.useMemo(
    () => datasets.find((item) => item.expName === targetExp) ?? datasets[0] ?? null,
    [datasets, targetExp]
  )
  const expName = dataset?.expName ?? ''
  const leg = GV_LEGS[legKind]

  // 体检看的是「当前选中的实验」：换实验就在数据块里选它，别让人猜在看谁。
  const preflight = React.useMemo(() => {
    if (!dataset) return []
    return judgeGvPreflight({
      expName: dataset.expName,
      missing: dataset.missing,
      gptTrained: runs.some((run) => run.kind === 'gv-gpt' && run.experiment === dataset.expName && run.status !== 'failed'),
      sovitsTrained: runs.some(
        (run) => run.kind === 'gv-sovits' && run.experiment === dataset.expName && run.status !== 'failed'
      )
    })
  }, [dataset, runs])

  // 「一眼」：四种开不了各有各的修法，不许只灰按钮（#178 的 Q5）。
  const blocker: Blocker | null = React.useMemo(() => {
    if (taskRunning) {
      return {
        pill: '在跑',
        text: `有任务在跑：${legLabelOf(task?.kind) ?? '训练'}——这一页现在开不了新的`,
        fix: '等它跑完（进度在训练块里），或者点那一行的「停止」'
      }
    }
    if (sovits !== null && !sovits.installed) {
      return {
        pill: '缺环境',
        text: '开不了：没装 GPT-SoVITS 引擎包',
        fix: '去「对讲 → TTS 服务」装引擎包；装完回这一页点「刷新」'
      }
    }
    if (datasets.length === 0) {
      return {
        pill: '缺数据',
        text: '开不了：磁盘上没有实验目录',
        fix: '在 GPT-SoVITS 的 webui 里跑完 1abc 三步（切音频 / 打标注 / 提特征），目录会出现在 logs/ 下'
      }
    }
    if (dataset && !dataset.ready) {
      return {
        pill: '缺备料',
        text: `开不了：${expName} 还缺 ${dataset.missing.join('、')}`,
        fix: '回 webui 把缺的那几步补齐（四件套齐了这里才会变成「能开训」），补完点「刷新」'
      }
    }
    return null
  }, [dataset, datasets.length, expName, sovits, task?.kind, taskRunning])

  const activePack = packs.find((pack) => pack.active) ?? null
  const registeredPack = packs.find((pack) => pack.name === registered) ?? null
  const newestRun = runs[0] ?? null
  const failedRun = newestRun && newestRun.status === 'failed' ? newestRun : null

  return (
    <>
      <Panel>
        <Group label="能不能跑">
          <Row
            label="现在"
            hint={blocker ? `${blocker.text} · ${blocker.fix}` : `能开训：${expName} 备料齐全，${legLabelOf(legKind)}先跑`}
          >
            <StatusPill tone={blocker ? 'bad' : 'ready'}>{blocker ? blocker.pill : '能开训'}</StatusPill>
          </Row>
          <Row
            label="引擎包"
            hint={
              sovits === null
                ? '还在读引擎包状态'
                : sovits.installed
                  ? `已装：${homeNameOf(sovits.home)}`
                  : `没装（${sovits.install.phase}）：装完才有 Python 与训练脚本，这里的「环境」指的就是这两样`
            }
          >
            {sovits !== null && !sovits.installed && sovits.install.phase !== 'idle' ? (
              <StatusPill tone="warn">{`${Math.round(sovits.install.progress)}%`}</StatusPill>
            ) : null}
          </Row>
          {/* #179：机器级三行（Python / 依赖 / 显存）。和上面「引擎包」不是一件事：
              那条说「装没装」，这条说「装了之后跑不跑得起来」；两句拼起来才是一句话。 */}
          <Row
            label="这台机器"
            stacked
            hint={machine === null ? '正在读机器状态…' : machineEnvLine(machine)}
          >
            <StatusPill
              tone={
                machine === null
                  ? 'idle'
                  : machineEnvState(machine) === 'ok'
                    ? 'ready'
                    : machineEnvState(machine) === 'warn'
                      ? 'warn'
                      : machineEnvState(machine) === 'bad'
                        ? 'bad'
                        : 'idle'
              }
            >
              {machine === null ? '读取中' : machineLabel(machine)}
            </StatusPill>
          </Row>
        </Group>
      </Panel>

      <Panel>
        <Group
          label="数据"
          action={
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              刷新
            </Button>
          }
        >
          <Row
            label="实验"
            htmlFor="v2-gv-exp"
            hint={
              dataset === null
                ? '没扫到实验：先跑 webui 的 1abc 三步'
                : dataset.ready
                  ? `备料齐全 · 已训 ${runs.filter((run) => run.experiment === dataset.expName).length} 次`
                  : `缺 ${dataset.missing.join('、')}`
            }
          >
            {dataset === null ? null : (
              <>
                <StatusPill tone={dataset.ready ? 'ready' : 'warn'}>{dataset.ready ? '可开训' : '缺备料'}</StatusPill>
                <select
                  id="v2-gv-exp"
                  className={selectClass}
                  value={expName}
                  onChange={(event) => setTargetExp(event.target.value)}
                  aria-label="实验"
                >
                  {datasets.map((item) => (
                    <option key={item.expName} value={item.expName}>
                      {item.expName}
                    </option>
                  ))}
                </select>
              </>
            )}
          </Row>
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
        <Group label="训练">
          <Row label="训练版本" htmlFor="v2-gv-version" hint="与底模成套：换版本等于换一套底模和权重目录">
            <select
              id="v2-gv-version"
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
          <Row
            label="开始训练"
            htmlFor="v2-gv-leg"
            hint={`默认 ${legLabelOf(DEFAULT_LEG)}：SoVITS 的声学腿吃 GPT 腿训出来的权重，先训语义腿；这次跑的是 ${legLabelOf(legKind)}（脚本 ${leg.script}）`}
            note={blocker ? `${blocker.text}。${blocker.fix}` : null}
          >
            <select
              id="v2-gv-leg"
              className={selectClass}
              value={legKind}
              onChange={(event) => setLegKind(event.target.value as GvLegKind)}
              aria-label="训练哪条腿"
            >
              <option value="gv-gpt">{legLabelOf('gv-gpt')}</option>
              <option value="gv-sovits">{legLabelOf('gv-sovits')}</option>
            </select>
            <Button
              size="sm"
              disabled={blocker !== null || dataset === null || Boolean(busy)}
              onClick={() =>
                void act('开始训练', async () => {
                  const result = await window.api.trainStart({
                    kind: legKind,
                    dataset: expName,
                    gv: { version, ...leg.defaults }
                  })
                  return result.ok ? `已开训 ${legLabelOf(legKind)}` : `开训失败：${result.error ?? '未知错误'}`
                })
              }
            >
              开始训练
            </Button>
          </Row>
          <TrainTaskRow task={task} running={taskRunning} label="训练中" now={now} />
          {failedRun === null ? null : (
            <Row
              label="上次结果"
              hint={`训练段失败：${failedRun.error ?? '进程非 0 退出'}｜${runStampOf(failedRun)}`}
            >
              <StatusPill tone="bad">失败</StatusPill>
            </Row>
          )}
          {preflight.length === 0 ? null : <Row label="体检" stacked hint={preflightSummary(preflight)} />}
        </Group>
      </Panel>

      {runs.length === 0 ? null : (
        <Panel>
          <Group label="训练记录">
            <Row label="最近几次" hint="一次开训留一条：时间、状态与指标都从产物里读回来" />
            {runs.slice(0, 3).map((run) => (
              <React.Fragment key={run.id}>
                <RunRow run={run} />
                <Sparkline run={run} />
              </React.Fragment>
            ))}
          </Group>
        </Panel>
      )}

      <Panel>
        <Group label="产物">
          <Row
            label="注册为音色包"
            hint={
              note ||
              (expName
                ? `把 ${expName} 训好的权重与参考音频登记成一个可选音色`
                : '先选一个训练好的实验')
            }
          >
            <select
              className={selectClass}
              value={targetExp}
              onChange={(event) => setTargetExp(event.target.value)}
              aria-label="注册的实验"
            >
              {datasets.map((item) => (
                <option key={item.expName} value={item.expName}>
                  {item.expName}
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
                  if (result.ok) setRegistered(name.trim())
                  return result.ok ? `已注册音色「${name.trim()}」，去朗读页选它` : `注册失败：${result.error ?? '未知错误'}`
                })
              }
            >
              注册
            </Button>
          </Row>
          <Row
            label="现役音色"
            hint={
              activePack === null
                ? '还没有现役音色：朗读与同声都用引擎默认嗓'
                : `现在是「${activePack.name}」${activePack.version ? ` · ${activePack.version}` : ''}`
            }
            note={
              registeredPack !== null && activePack !== null && registeredPack.id !== activePack.id
                ? '换掉的是三样：参考音频 + GPT 权重 + SoVITS 权重（旧的留在盘上，能再换回来）'
                : null
            }
          >
            {registeredPack !== null && activePack !== null && registeredPack.id !== activePack.id ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void act('换现役', async () => {
                    const next = await window.api.sovitsSelectPack(registeredPack.id)
                    setPacks(next)
                    return `现役换成「${registeredPack.name}」`
                  })
                }
              >
                换成这一版
              </Button>
            ) : null}
          </Row>
          <Row
            label="训练产物位置"
            hint={expName ? `logs/${expName}/logs_s1_v2 · logs_s2_v2 · 权重在 GPT_weights_*/SoVITS_weights_*` : '—'}
          >
            <StatusPill tone="idle">训练目录</StatusPill>
          </Row>
        </Group>
      </Panel>
    </>
  )
}

function legLabelOf(kind: string | undefined): string {
  if (kind === 'gv-gpt' || kind === 'gv-sovits') return GV_LEGS[kind].label
  return '训练'
}

function homeNameOf(home: string): string {
  if (!home) return '引擎包目录还没定'
  const parts = home.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? home
}

/** 机器级三行的一句话状态（#179）：测不到写「测不到」，不许写成「正常」。 */
function machineLabel(report: MachineEnvReport): string {
  const state = machineEnvState(report)
  if (state === 'ok') return '能跑'
  if (state === 'warn') return '偏紧'
  if (state === 'bad') return '缺东西'
  return '测不到'
}

function runStampOf(run: TrainRunRecord): string {
  const at = run.endedAt ?? run.startedAt
  if (!at) return '时间不详'
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/** 体检只留一句：把三条并成「备料齐 · GPT 腿训过 · SoVITS 腿还没训」，逐条列表留给不在这一页的地方。 */