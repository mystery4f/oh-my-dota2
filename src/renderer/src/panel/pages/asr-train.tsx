import * as React from 'react'
import type { FtRecInfo, FtScriptState } from '@shared/ipc'
import type { AsrFtFacts, AsrFtMode, AsrFtStatusResult } from '@shared/train/asr-ft'
import { ASR_ENGINES, finetunableEngines, type AsrEngineId } from '@shared/asr/engines'
import type { TrainSnapshot } from '@shared/train/task'
import { judgeAsrPreflight, preflightBlocks } from '@shared/train/preflight'
import type { TrainRunRecord } from '@shared/train/run'
import {
  CUSTOM_GROUP,
  appendScriptLine,
  ensureCustomGroup,
  nextUnrecordedLine,
  recordingKey,
  takeLineId
} from '@shared/train/recording'
import { CORRECTION_GROUP } from '@shared/train/corrections'
import { normalizeLine } from '@shared/chat-line'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, StatusPill } from '../components/primitives'
import { Modal } from '../components/modal'
import { ScriptEditor } from '../components/script-editor'
import { PreflightList, RunRow, Sparkline } from '../components/run-view'
import { TrainTaskRow } from '../components/train-task-row'
import { useTrainConsole } from '../use-train-console'
import { selectClass } from '../components/select-class'
import { useRecorder, type RecorderTarget } from '../use-recorder'
import { useSaveFlash, useSettings } from '../use-settings'

/** 开训方式的两档：接着上一轮权重（只补新错，默认）与从底模重训（最稳的底）。 */
const FT_MODE_OPTIONS: { id: AsrFtMode; label: string }[] = [
  { id: 'incremental', label: '接着上次权重' },
  { id: 'fresh', label: '从底模重训' }
]

/** 左侧四步：环境 → 数据 → 训练 → 现役。它同时是状态机的导航。 */
const STEPS = [
  { id: 'env', label: '环境' },
  { id: 'data', label: '数据' },
  { id: 'train', label: '训练' },
  { id: 'live', label: '现役' }
] as const

type StepId = (typeof STEPS)[number]['id']

/** 六态：页面永远先说清「现在在哪一步、下一步点哪里」。 */
type PageState = 'env' | 'nodata' | 'ready' | 'running' | 'live' | 'failed'

/**
 * 识别训练：左侧四步（环境 / 数据 / 训练 / 现役），右侧是当前状态与所选那一步的明细。
 * 状态只有一个来源（ftAsrftStatus + 最近一条训练记录），页面不自己攒第二份判断。
 */
export function AsrTrainPage(): React.ReactElement {
  const [script, setScript] = React.useState<FtScriptState | null>(null)
  // 读稿编辑抽屉：组和句子都在里面改，保存才落盘（改文本 = 那句要重录）。
  const [editingScript, setEditingScript] = React.useState(false)
  const [recs, setRecs] = React.useState<Record<string, FtRecInfo>>({})
  const [status, setStatus] = React.useState<AsrFtStatusResult | null>(null)
  const [runs, setRuns] = React.useState<TrainRunRecord[]>([])
  const [groupId, setGroupId] = React.useState('')
  const [lineNo, setLineNo] = React.useState(1)
  const [asrText, setAsrText] = React.useState('')
  const [packed, setPacked] = React.useState<{ train: number; eval: number } | null>(null)
  const [facts, setFacts] = React.useState<AsrFtFacts | null>(null)
  const [step, setStep] = React.useState<StepId>('data')
  const [customText, setCustomText] = React.useState('')
  // 纠错样本（#66）的开关归这个页面管（数据就长在这一页），落盘走统一设置入口。
  const { settings, update } = useSettings()
  // 现役引擎名（设置里的 id 是 `<engine>:<rel>`）：训练目标与它不同时，页面上要说清「训完才切」。
  const activeEngineLabel = ASR_ENGINES[settings?.asrActiveModel.split(':')[0] as AsrEngineId]?.label ?? ''
  const save = useSaveFlash()
  // 开训方式：接着上次权重 / 从底模重训。默认接上一轮（常态是「补新录的错」），
  // 只有上一轮权重不在时才落回重训——那是没得选，不是替用户改主意。
  const [mode, setMode] = React.useState<AsrFtMode>('incremental')
  const modeTouched = React.useRef(false)
  React.useEffect(() => {
    if (modeTouched.current || !facts || facts.incremental) return
    setMode('fresh')
  }, [facts])

  const groups = script?.groups ?? []
  const group = groups.find((item) => item.id === groupId) ?? groups[0] ?? null
  const customGroup = groups.find((item) => item.id === CUSTOM_GROUP) ?? null

  const loadRecs = React.useCallback(async (): Promise<Record<string, FtRecInfo>> => {
    const list = await window.api.ftRecList()
    const next: Record<string, FtRecInfo> = {}
    for (const info of list) next[info.key] = info
    return next
  }, [])

  const refreshRecs = React.useCallback(async (): Promise<void> => {
    setRecs(await loadRecs())
  }, [loadRecs])

  const refreshRuns = React.useCallback(async (): Promise<void> => {
    setRuns(await window.api.trainRuns())
  }, [])

  const refreshStatus = React.useCallback(async (): Promise<void> => {
    setStatus(await window.api.ftAsrftStatus())
  }, [])

  const refreshAll = React.useCallback(async (): Promise<void> => {
    await Promise.all([refreshRecs(), refreshStatus(), refreshRuns()])
  }, [refreshRecs, refreshRuns, refreshStatus])

  const load = React.useCallback(async (): Promise<TrainSnapshot> => {
    const [nextScript, nextSnapshot, nextFacts] = await Promise.all([
      window.api.ftScriptRead(),
      window.api.trainSnapshot(),
      window.api.ftAsrftFacts()
    ])
    setFacts(nextFacts)
    setScript(nextScript)
    if (nextScript.groups.length > 0) setGroupId((current) => current || nextScript.groups[0].id)
    await refreshAll()
    return nextSnapshot
  }, [refreshAll])

  // 状态订阅、动作单飞与「当前任务」都归运行台；这里只剩收场后要刷新哪些列表。
  const { task, taskRunning, busy, note, run: runAction } = useTrainConsole(load)

  // 存完一条自动落到「下一条没录的句」：候选只来自 nextUnrecordedLine（排除已录行与当前句），
  // 整组录完返回 null → 停在原地、面板出完成态。存失败/没麦克风走不到这个回调，所以绝不会覆盖。
  const handleSaved = React.useCallback(
    async (target: RecorderTarget): Promise<void> => {
      const next = await loadRecs()
      setRecs(next)
      // 新录音已落账（ft-record → recordDatasetTake）：待训数字得跟着涨，不然存完看着没反应。
      void refreshStatus()
      const savedGroup = script?.groups.find((item) => item.id === target.group) ?? null
      if (!savedGroup || target.mode !== 'lines') return
      const lines = savedGroup.lines.map((line) => line.no)
      const recorded = lines.filter((no) => next[recordingKey(savedGroup.id, 'lines', no)])
      const nextLine = nextUnrecordedLine({ lines, recorded, current: target.line })
      if (nextLine !== null) setLineNo(nextLine)
    },
    [loadRecs, refreshStatus, script]
  )

  const recorder = useRecorder(handleSaved)

  React.useEffect(() => {
    if (group && !group.lines.some((line) => line.no === lineNo)) setLineNo(group.lines[0]?.no ?? 1)
  }, [group, lineNo])

  // 开训就把人送到训练那一步：进度与停止都在那儿。
  React.useEffect(() => {
    if (taskRunning) setStep('train')
  }, [taskRunning])

  const recordedLines = group ? group.lines.filter((line) => recs[recordingKey(group.id, group.mode, line.no)]) : []
  const groupComplete = Boolean(group && group.mode === 'lines' && group.lines.length > 0 && recordedLines.length === group.lines.length)
  const activeRec = group ? recs[recordingKey(group.id, group.mode, lineNo)] : undefined
  const currentLine = group?.lines.find((line) => line.no === lineNo) ?? null
  const coverage = group && status ? status.coverage[group.id] : undefined
  const totalLines = groups.reduce((sum, item) => sum + item.lines.length, 0)

  // 体检是纯函数缝（shared/train/preflight）：页面只负责把事实喂进去，结论与文案都在一起测。
  const { preflight, blocks } = React.useMemo(() => {
    const items = judgeAsrPreflight({
      env: status?.env ?? { ok: false, gaps: ['状态还没读到'] },
      recordedLines: Object.keys(recs).length,
      packed,
      activeModel: Boolean(status?.swap.activeExists),
      mode,
      incrementalAvailable: facts?.incremental ?? false,
      vramNote: facts?.vramNote ?? null
    })
    return { preflight: items, blocks: preflightBlocks(items) }
  }, [status, recs, packed, facts, mode])

  const startTraining = (): void => {
    void runAction('开训', async () => {
      const result = await window.api.trainStart({ kind: 'asr-ft', dataset: group?.id ?? 'asr-ft', mode })
      return result.ok ? '已开训' : `开训失败：${result.error ?? '未知错误'}`
    })
  }

  const stopTraining = (): void => {
    void runAction('停止', async () => {
      await window.api.trainStop()
      return '已请求停止'
    })
  }

  const installEnv = (): void => {
    void runAction('安装环境', async () => {
      await window.api.ftAsrftInstall()
      return '安装已开始，进度看「当前任务」'
    })
  }

  // 自定义录音：先有文本再录。文本进读稿的 G99 组，录音走同一条通路上账，
  // 所以打包、待训、覆盖率都不用为它写第二套判据。
  const addCustomTake = (): void => {
    const text = customText.trim()
    if (!text) return
    void runAction('自定义录音', async () => {
      const edit = appendScriptLine(ensureCustomGroup(groups), CUSTOM_GROUP, text)
      if (!edit.ok) return edit.error
      const saved = await window.api.ftScriptSave(edit.groups)
      setScript(saved)
      setCustomText('')
      const line = saved.groups.find((item) => item.id === CUSTOM_GROUP)?.lines.slice(-1)[0]
      if (!line) return '已写进读稿，但没找到这一句'
      setGroupId(CUSTOM_GROUP)
      setLineNo(line.no)
      await recorder.begin({ group: CUSTOM_GROUP, mode: 'lines', line: line.no })
      return '已加一句，开始录'
    })
  }

  const state = React.useMemo<PageState>(() => {
    if (!status) return 'env'
    if (!status.env.ok) return 'env'
    if (taskRunning) return 'running'
    if (runs[0]?.status === 'failed') return 'failed'
    const trained = Object.values(status.coverage).reduce((sum, item) => sum + item.done, 0)
    if (!status.swap.activeExists && status.pending.count === 0 && trained === 0) return 'nodata'
    if (status.swap.activeExists && status.pending.count === 0) return 'live'
    return 'ready'
  }, [status, taskRunning, runs])

  // 首屏按状态选步，之后人点哪步就是哪步：状态再变也不把人从正在看的地方拽走。
  const picked = React.useRef(false)
  React.useEffect(() => {
    if (picked.current || !status) return
    picked.current = true
    if (!status.env.ok) setStep('env')
    else if (!status.swap.activeExists && status.pending.count === 0) setStep('data')
    else if (status.pending.count > 0) setStep('train')
    else setStep('live')
  }, [status])

  const headline = ((): {
    title: string
    hint: string
    action?: { label: string; step: StepId; disabled?: boolean; run: () => void }
  } => {
    if (state === 'env')
      return {
        title: '缺少训练环境',
        hint: `还差 ${status?.env.gaps.length ?? 0} 项依赖：装好才能开训，录音、纠错、打包都不受影响。`,
        action: { label: '安装环境', step: 'env', disabled: Boolean(busy) || taskRunning, run: installEnv }
      }
    if (state === 'nodata')
      return {
        title: '还没有可训练的数据',
        hint: '先录一组读稿：说完自动停，存完跳下一句；也可以写一句话再录。',
        action: { label: '去录音', step: 'data', run: () => setStep('data') }
      }
    if (state === 'running')
      return {
        title: '正在训练',
        hint: `${task?.stage || '准备中'} · ${task?.progress ?? 0}%｜中途停掉不会动现役模型`,
        action: { label: '停止', step: 'train', run: stopTraining }
      }
    if (state === 'failed')
      return {
        title: '上次训练失败了',
        hint: `${runs[0]?.error ?? '记录里没写原因'}｜旧模型没动，改完再开一轮`,
        action: { label: '重试', step: 'train', disabled: blocks.length > 0, run: startTraining }
      }
    if (state === 'live')
      return {
        title: '现役模型已就位',
        hint: `${status?.target.label ?? '微调模型'} 正在用｜有新录音时才需要再训一轮`
      }
    return {
      title: '可以开训',
      hint: `${status?.pending.label ?? ''}｜全量 ${status?.estimate.fresh.label ?? ''}，增量 ${status?.estimate.incremental.label ?? ''}`,
      action: { label: '开始训练', step: 'train', disabled: blocks.length > 0, run: startTraining }
    }
  })()

  const stepSummary: Record<StepId, string> = {
    env: status ? (status.env.ok ? '就绪' : `缺 ${status.env.gaps.length} 项`) : '…',
    data: script ? `${Object.keys(recs).length}/${totalLines} 句已录` : '读稿还没读出来',
    train: taskRunning ? `${task?.progress ?? 0}%` : status ? `待训 ${status.pending.count} 条` : '…',
    live: status?.swap.activeExists ? `${status.target.label} 已就位` : '还没换过模型'
  }

  return (
    <>
      <div className="flex gap-6">
        <ol className="w-[188px] shrink-0 space-y-0.5 border-r border-border/60 pr-4">
          {STEPS.map((item) => {
            const active = item.id === step
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setStep(item.id)}
                  aria-current={active ? 'step' : undefined}
                  className={
                    active
                      ? 'w-full rounded bg-muted px-2 py-1.5 text-left text-sm text-foreground'
                      : 'w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  }
                >
                  <span className="block">{item.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{stepSummary[item.id]}</span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4 border-b border-border/60 pb-4">
            <div className="min-w-0">
              <h2 className="text-[15px] font-medium">{headline.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{headline.hint}</p>
            </div>
            {headline.action && headline.action.step !== step ? (
              <Button size="sm" disabled={headline.action.disabled} onClick={headline.action.run}>
                {headline.action.label}
              </Button>
            ) : null}
          </div>

          <div className="divide-y divide-border/40">
            {step === 'env' ? (
              <>
                {/* 训练目标和现役分开选：运行时模型被删掉也照样能训（底模在训练环境里），
                    「识别用 A、训练 B」也成立；转正时 applyAsrFtModel 会把现役切到训完的那个引擎。 */}
                <Row
                  label="训练目标"
                  hint={
                    status
                      ? `${status.target.trainer === 'funasr-paraformer' ? 'FunASR 全参数微调' : 'Qwen3 SFT'} · 底模 ${status.target.baseModel || '未定'}`
                      : '正在读状态…'
                  }
                >
                  <div className="flex items-center gap-1">
                    {finetunableEngines().map((engine) => (
                      <button
                        key={engine.id}
                        type="button"
                        onClick={() => {
                          void update({ asrTrainEngine: engine.id }).then(() => refreshStatus())
                        }}
                        aria-pressed={status?.target.engineId === engine.id}
                        className={
                          status?.target.engineId === engine.id
                            ? 'rounded bg-muted px-2.5 py-1 text-xs font-medium text-foreground'
                            : 'rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
                        }
                      >
                        {engine.label}
                      </button>
                    ))}
                  </div>
                </Row>
                  {/* 训练目标和现役不同时，这句单独成行：塞进 Row 的标签列会被长底模 id 挤成竖条。 */}
                  {status && activeEngineLabel && activeEngineLabel !== status.target.label ? (
                    <p className="pb-2 text-xs leading-relaxed text-muted-foreground">
                      现役是 {activeEngineLabel}：训练不影响它，训完会自动切到 {status.target.label}。
                    </p>
                  ) : null}
                {status ? (
                  status.env.ok ? (
                    <Row label="Python 与依赖" hint="训练用的那套解释器，和游戏进程无关">
                      <StatusPill tone="ready">就绪</StatusPill>
                    </Row>
                  ) : (
                    <Row label="还缺的依赖" stacked hint="缺一项就开不了训；录音与打包不受影响">
                      <ul className="space-y-1 text-xs text-amber-300">
                        {status.env.gaps.map((gap) => (
                          <li key={gap}>· {gap}</li>
                        ))}
                      </ul>
                    </Row>
                  )
                ) : null}
                <Row label="安装" hint="装完自动重读环境；进度看「当前任务」">
                  <Button size="sm" variant="outline" disabled={Boolean(busy) || taskRunning} onClick={installEnv}>
                    安装环境
                  </Button>
                </Row>
              </>
            ) : null}

            {step === 'data' ? (
              <>
                <Row
                  label="读稿"
                  hint={
                    script
                      ? `${script.source === 'data' ? '数据目录（自定义）' : '随包自带'} · ${script.path}`
                      : '读稿还没读出来'
                  }
                >
                  {script ? (
                    <StatusPill tone={script.source === 'data' ? 'ready' : 'idle'}>
                      {script.source === 'data' ? '自定义' : '随包'}
                    </StatusPill>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!script}
                    title="在面板里改组和句子，保存后写回数据目录那份读稿"
                    onClick={() => setEditingScript(true)}
                  >
                    编辑
                  </Button>
                  {script?.source === 'data' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="删掉数据目录那份读稿，回到随包自带的那份"
                      onClick={() =>
                        void runAction('恢复随包读稿', async () => {
                          const next = await window.api.ftScriptReset()
                          setScript(next)
                          return '已回到随包读稿'
                        })
                      }
                    >
                      恢复随包
                    </Button>
                  ) : null}
                </Row>
                {script?.warning ? <p className="py-2 text-xs text-amber-300">{script.warning}</p> : null}
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
                  {groupComplete ? <StatusPill tone="ready">整组录完</StatusPill> : null}
                  {coverage ? (
                    <StatusPill tone={coverage.stale > 0 ? 'warn' : 'ready'}>
                      已训 {coverage.done}/{coverage.total}
                    </StatusPill>
                  ) : null}
                </Row>

                {group && group.mode === 'lines' ? (
                  <Row label="句子" stacked hint={currentLine ? currentLine.text : '这一组没有稿子'}>
                    <div className="flex flex-wrap items-center gap-1">
                      {group.lines.map((line) => {
                        const key = recordingKey(group.id, group.mode, line.no)
                        const has = recs[key]
                        // 稿子改了但这句还是按旧文本录的：wav 在，但它现在会让「增量」判据不通过。
                        const stale = has !== undefined && (status?.scriptStale ?? []).includes(key)
                        return (
                          <Button
                            key={line.no}
                            size="sm"
                            variant={line.no === lineNo ? 'default' : has ? 'secondary' : 'ghost'}
                            className={stale ? 'border border-amber-500/50 text-amber-300' : undefined}
                            title={
                              stale
                                ? `第 ${line.no} 句的稿子改过了，重录才能进新的训练集`
                                : has
                                  ? `第 ${line.no} 句已录，点一下重录（会覆盖）`
                                  : `第 ${line.no} 句还没录`
                            }
                            aria-label={`第 ${line.no} 句${has ? '（已录）' : '（未录）'}`}
                            onClick={() => setLineNo(line.no)}
                          >
                            {has ? <span aria-hidden="true">✓</span> : null}
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
                      : groupComplete
                        ? '整组录完：点要重录的句号再开录，存完停在原地'
                        : '点录制开始，说完自动停，存完自动跳下一句没录的')
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={taskRunning || recorder.recording || !group || group.mode !== 'lines'}
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

                <Row
                  label="纠错样本"
                  hint={
                    status?.corrections
                      ? `语音页改对一句，就把它那句的原始录音存成 ${CORRECTION_GROUP} 的自由说样本（标签 = 改对的句子），打包时一起进训练集；到顶只停写，不删旧样本`
                      : '语音页改对一句，那句的原始录音会存成自由说样本（状态还没读到）'
                  }
                >
                  {status?.corrections ? (
                    <StatusPill tone={status.corrections.atCap ? 'warn' : 'idle'}>
                      {status.corrections.count}/{status.corrections.maxCount} 条 ·{' '}
                      {(status.corrections.bytes / 1024 / 1024).toFixed(1)}/
                      {Math.round(status.corrections.maxBytes / 1024 / 1024)}MB
                    </StatusPill>
                  ) : null}
                  <Button
                    size="sm"
                    variant={settings?.asrCorrectionsToDataset ? 'secondary' : 'outline'}
                    title="关掉 = 纠错只并热词，不写任何文件"
                    onClick={() =>
                      void save.wrap(update({ asrCorrectionsToDataset: !(settings?.asrCorrectionsToDataset ?? true) }))
                    }
                  >
                    {settings?.asrCorrectionsToDataset ? '开' : '关'}
                  </Button>
                </Row>
                {status?.corrections.notice ? (
                  <p className="py-2 text-xs text-amber-300">{status.corrections.notice}</p>
                ) : null}

                <Row
                  label="自定义录音"
                  stacked
                  hint={
                    customGroup
                      ? `${CUSTOM_GROUP} 组已有 ${customGroup.lines.length} 句：写一句、录一句，存完自动停`
                      : '写一句你常说的话，录一遍——它会成为这组的下一句，训练时按这行文本对齐'
                  }
                >
                  <div className="flex items-center gap-2">
                    <input
                      className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm placeholder:text-muted-foreground"
                      placeholder="比如：这波别追，先清兵"
                      value={customText}
                      onChange={(event) => setCustomText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') addCustomTake()
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={!customText.trim() || taskRunning || recorder.recording}
                      onClick={addCustomTake}
                    >
                      加一句并录制
                    </Button>
                  </div>
                </Row>

                <Row label="打包数据集" hint={note || '已录句子 × 稿子 → 训练/验证两份 jsonl，训练脚本直接吃'}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy) || taskRunning}
                    onClick={() =>
                      void runAction('打包', async () => {
                        const result = await window.api.ftDatasetPrepare()
                        // 缺文件的纠错样本被跳过（打包照常）：把跳过的键说出来，别让人以为它们也训了。
                        const skipped = result.skippedCorrections.length
                          ? `；跳过 ${result.skippedCorrections.length} 条找不到录音的纠错样本（${result.skippedCorrections.join('、')}）`
                          : ''
                        if (result.ok) setPacked({ train: result.trainCount, eval: result.evalCount })
                        return result.ok
                          ? `已打包：训练 ${result.trainCount} 条 / 验证 ${result.evalCount} 条${skipped}`
                          : `打包失败：${result.error ?? '未知错误'}${skipped}`
                      })
                    }
                  >
                    打包
                  </Button>
                </Row>
              </>
            ) : null}

            {step === 'train' ? (
              <>
                <TrainTaskRow flush task={task} running={taskRunning} />
                <PreflightList flush items={preflight} />
                {/* 待训数据（#64）：录了还没被任何一次 run 吃掉的条数与时长，从数据集账本推。够轮数只提示，不自动开训。 */}
                <Row
                  label="待训数据"
                  hint={
                    status
                      ? status.pending.count > 0
                        ? `${status.pending.label}；开不开训由你点，不会自己跑`
                        : '账本里没有待训数据：录完一条这里就涨'
                        : '正在读状态…'
                  }
                >
                  {status?.pending.prompt ? <StatusPill tone="warn">够再训一次</StatusPill> : null}
                </Row>

                <Row
                  label="开训方式"
                  hint={
                    mode === 'incremental'
                      ? '接上一轮的权重：只补这批新录的错，步数看下方「预计耗时」；验证集沿用上一轮，新录的句子只进训练集'
                      : '从底模重训：轮数按录音量自动算，步数看下方「预计耗时」；换引擎或重录过就用它'
                  }
                >
                  <div className="flex items-center gap-1">
                    {FT_MODE_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => {
                          modeTouched.current = true
                          setMode(option.id)
                        }}
                        aria-pressed={mode === option.id}
                        className={
                          mode === option.id
                            ? 'rounded bg-muted px-2.5 py-1 text-xs font-medium text-foreground'
                            : 'rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
                        }
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </Row>

                {/* 预计耗时（#65）：纯显示，不排程也不拦人；数字来自 shared/train/asr-ft 的 estimateFtCost，面板不自己算。 */}
                {/* 基准那句是整段说明，不塞进 Row 的标签列（会被压成一条竖线），放成值下面的一整行。 */}
                <Row label="预计耗时">
                  <span className="text-sm">{status?.estimate[mode].label ?? '…'}</span>
                </Row>
                <p className="py-2 text-xs leading-relaxed text-muted-foreground">
                  {status?.estimateBasis ?? '正在读状态…'}
                </p>

                <Row
                  label="开训"
                  hint={
                    blocks.length > 0
                      ? `先解决：${blocks.map((item) => item.label).join('、')}`
                      : mode === 'incremental'
                        ? '接上一轮的权重，步数跟上方估算一致'
                        : '轮数按录音量自动算，步数跟上方估算一致'
                  }
                >
                  <Button size="sm" disabled={taskRunning || blocks.length > 0} onClick={startTraining}>
                    开始训练
                  </Button>
                </Row>

                {/* 最近三条：再多就是台账了，历史全量还在 runs.db 里。框起来是为了和上面的
                    设置行区分——这几行是「结果」，不是「可以改的设置」。 */}
                {runs.length === 0 ? (
                  <Row label="训练记录" hint="还没有记录：跑一次就会在磁盘上留一条" />
                ) : (
                  <div className="py-2">
                    <Panel>
                      <Group label="最近训练">
                        {runs.slice(0, 3).map((run) => (
                          <div key={run.id}>
                            <RunRow run={run} />
                            <Sparkline run={run} />
                          </div>
                        ))}
                      </Group>
                    </Panel>
                  </div>
                )}
              </>
            ) : null}

            {step === 'live' ? (
              <>
                <Row
                  label="生效模型"
                  hint={
                    status
                      ? status.swap.activeExists
                        ? `目录 ${status.target.modelDir}`
                        : '还没有微调模型：训练一次成功就会自动换上'
                      : '正在读状态…'
                  }
                >
                  <StatusPill tone={status?.swap.activeExists ? 'ready' : 'warn'}>
                    {status?.swap.activeExists ? '已就位' : '缺模型'}
                  </StatusPill>
                </Row>
                <Row label="最近导出" hint={status?.swap.lastExportDir ?? '还没有导出的权重'} />
                <Row
                  label="换模"
                  hint="训练成功自动换上新模型；失败保留旧模型。这里只读，不提供按钮"
                />
                {status?.swap.bakExists ? (
                  <Row label="旧的微调模型" hint="还留在磁盘上，只作为最后一次失败时的兜底" />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>

      <Modal
        open={editingScript}
        title="编辑读稿"
        hint="组和句子都能增删改；删掉的编号不再复用。保存后写回数据目录的读稿，改过的句子需要重录。"
        onClose={() => setEditingScript(false)}
      >
        <ScriptEditor
          groups={groups}
          recordedKeys={Object.keys(recs)}
          onClose={() => setEditingScript(false)}
          onSaved={(next) => {
            setScript((prev) => (prev ? { ...prev, groups: next } : prev))
            void refreshStatus()
          }}
        />
      </Modal>
    </>
  )
}
