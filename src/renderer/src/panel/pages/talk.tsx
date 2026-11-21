import { useCallback, useEffect, useRef, useState } from 'react'
import {
  OFFLINE_VOICES,
  type OfflineStatus,
  type VoiceChainLast,
  type VoiceChainSummary,
  type VoiceOutEngine,
  type VoiceOutTestResult,
  type VoiceRuntimeStatus
} from '@shared/ipc'
import {
  DEFAULT_VOICE_OUT_VOICE,
  VOICE_OUT_VOICES,
  findCableOutput,
  isVirtualCableName,
  judgeCableGap,
  type VirtualCableStatus
} from '@shared/voice-out'
import { extractHotwordDiff, mergeHotwords } from '@shared/asr-hotwords'
import { formatChainTiming } from '@shared/voice-timing'
import { queueLine, stopLine, type SpeechQueueSnapshot } from '@shared/speech-queue'
import type { MicHealthEvent } from '@shared/mic-health'
import { interpretDeviceLine, interpretFollowNote } from '@shared/interpret'
import type { ShadowView } from '@shared/shadow-voice'
import { formatMuteList, muteLine, muteTableOf, parseMuteList } from '@shared/speak-mute'
import {
  SPEECH_SPLIT_LABELS,
  SPEECH_SPLIT_STRATEGIES,
  SPLIT_SAMPLE,
  previewSplit,
  splitPreviewLine
} from '@shared/speech-split'
import { planCableAutoSelect } from '@shared/cable-autoselect'
import { machineCheckOffer } from '@shared/env-report'
import { ASR_ENGINES } from '@shared/asr/engines'
import type { AsrState } from '@shared/asr/models'
import {
  voiceOutReadinessVisible,
  type VoiceOutAction,
  type VoiceOutReadiness
} from '@shared/voice-out-readiness'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Group, Panel, Row, SaveFlash, StatusPill } from '../components/primitives'
import { selectClass } from '../components/select-class'
import { Modal } from '../components/modal'
import { errorMessage } from '@shared/errors'
import { HotwordEditor } from '../components/hotword-editor'
import { HotwordCandidateBox } from '../components/hotword-suggestions'
import { useSaveFlash, useSettings } from '../use-settings'
import { useVoicePacks } from '../use-voice-packs'
import { VoicePackDisplay } from '../components/voice-pack-display'

/**
 * 一行日志 = 一次语音链结果 + 面板本地字段。纠错不再自己保存「原话」：找原音靠的是
 * `utteranceId`（识别那一刻主进程发下来的票），它在 `VoiceChainSummary` 里，改几次都不会变。
 */
type LogEntry = VoiceChainSummary & { at: number; corrected?: boolean }

/** 断链时的唯一动作按钮文案：动作是给人看的，不是给代码看的。 */
const READINESS_ACTION_LABEL: Record<VoiceOutAction, string> = {
  'install-engine': '去装引擎包…',
  'open-packs': '装音色包…',
  'start-service': '启动服务'
}

const OUT_ENGINE_LABEL: Record<VoiceOutEngine, string> = {
  edge: 'Edge 英文嗓',
  offline: '离线模型',
  sovits: 'GPT-SoVITS'
}

/** 设备 id → 面板显示的名字（#145）：空 id 就是没选，列表里没有就说「当前未接入」。 */
function deviceLabelOf(outputs: { deviceId: string; label: string }[], id: string): string {
  if (id === '') return ''
  return outputs.find((device) => device.deviceId === id)?.label ?? '（已保存，当前未接入）'
}

/** 摘要行里的一段：`名字 · 问题` 或只有 `名字`；问题那段永远排在后面，读起来才知道是同一个东西出的毛病。 */
function summaryPart(name: string, problem: string | null): string {
  return problem === null || problem === '' ? name : `${name} · ${problem}`
}

/**
 * 抽屉里的一行（#174）：两列窄排，刻意不用 `Row` —— 这一页的行是 13 行的预算，
 * 而抽屉里的东西「装一次就不动」，不该按页面主行来排。每一项都必须写出「现在是什么」。
 */
function DrawerRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3 border-t border-border/60 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint ? <div className="text-xs leading-4 text-muted-foreground">{hint}</div> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/**
 * 对讲页（#174）：把 25 行收成四块 + 一个「全部调整」抽屉。
 *
 * 一眼的事只有三件：现在收谁的声音、现在念给谁听、上一次对讲卡在哪。
 * 设备 / 引擎 / 音色 / 语速这四项装好之后基本不动，收进抽屉，但摘要行必须把「现在是什么」和
 * 「哪一项有毛病」一起写出来 —— 这行是整页唯一的一眼，它骗人比没有更糟。
 */
export function TalkPage({
  onOpenVoicePacks,
  onOpenMachineCheck
}: {
  /** 打开音色包弹窗（与朗读页同一个）。 */
  onOpenVoicePacks?: () => void
  /** 跳到总览的「这台机器」（#140）：告警在别的页时，用户不该自己想到去总览翻六行。 */
  onOpenMachineCheck?: () => void
}): React.ReactElement {
  const { settings, update, loadError } = useSettings()
  const save = useSaveFlash()
  // 声出走 GV 时才需要报出当前音色包；换包本身在弹窗里，这里只读。
  const voicePacks = useVoicePacks(settings?.ttsOutEngine === 'sovits')

  const [shadow, setShadow] = useState<ShadowView | null>(null)
  const [asrStatus, setAsrStatus] = useState<OfflineStatus | null>(null)
  // 模型注册表：换模型只是换一个 id，面板因此不需要知道有几种引擎存在。
  const [asrModels, setAsrModels] = useState<AsrState | null>(null)
  const [runtime, setRuntime] = useState<VoiceRuntimeStatus | null>(null)
  const [outBusy, setOutBusy] = useState(false)
  const [outResult, setOutResult] = useState<VoiceOutTestResult | null>(null)
  // 声出就绪快照：进页读一次，之后主进程只在变化时推（面板不自己开定时器）。
  const [readiness, setReadiness] = useState<VoiceOutReadiness | null>(null)
  // 语音队列（#88）：进页读一次快照，之后主进程一变就推；面板不自己数余量。
  const [queue, setQueue] = useState<SpeechQueueSnapshot | null>(null)
  const [queueBusy, setQueueBusy] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  // 麦克风健康（#96）：浮层边录边报，面板只画（电平条 + 掉线提示）。
  const [micHealth, setMicHealth] = useState<MicHealthEvent | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [editingAt, setEditingAt] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  // 纠错样本（#66）的即时回执：存上了说存到哪条，到顶了说为什么没存（这条提示就是唯一出口）。
  const [correctionNote, setCorrectionNote] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  // 讲话设备（声音输入）：伪设备（default / communications）照列，选中的值由 pickCaptureDevice 兜底。
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  // 虚拟声卡（VB-Cable）：声出进游戏语音的前置。问主进程（驱动层），不拿空 label 当「没装」。
  const [cable, setCable] = useState<VirtualCableStatus | null>(null)
  const [cableGuideOpen, setCableGuideOpen] = useState(false)
  const [linkNote, setLinkNote] = useState<string | null>(null)
  const [installingCable, setInstallingCable] = useState(false)
  // 抽屉（#174）：设备 / 引擎 / 音色 / 语速这类「装一次就不动」的东西默认收起。
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 上一次对讲（#167 的主进程内存最后一条）：带 matchid，跨局就不显示内容。
  const [chainLast, setChainLast] = useState<VoiceChainLast | null>(null)
  const [chainRead, setChainRead] = useState(true)

  // 识别模型状态：进面板问一次，下载/解压期间每秒刷——别让人对着假进度等。
  useEffect(() => {
    void window.api.asrStatus().then(setAsrStatus)
    void window.api.asrModels().then(setAsrModels)
  }, [])
  useEffect(() => {
    if (!asrStatus?.downloading) return
    const timer = setInterval(() => void window.api.asrStatus().then(setAsrStatus), 1000)
    return () => clearInterval(timer)
  }, [asrStatus?.downloading])

  useEffect(() => window.api.onVoiceChainResult((r) => setLog((l) => [{ ...r, at: Date.now() }, ...l].slice(0, 6))), [])
  useEffect(() => window.api.onVoiceRecordState((s) => setRecording(s.recording)), [])
  useEffect(() => window.api.onMicHealth(setMicHealth), [])
  useEffect(() => {
    // 运行时状态：进页问一次，装的时候主进程广播各阶段，不再轮询。
    void window.api.voiceRuntimeStatus().then(setRuntime)
  }, [])
  useEffect(() => window.api.onVoiceRuntimeState(setRuntime), [])
  useEffect(() => {
    void window.api.voiceOutReadiness().then(setReadiness)
  }, [])
  useEffect(() => window.api.onVoiceOutReadiness(setReadiness), [])
  useEffect(() => {
    void window.api.voiceOutShadow().then(setShadow)
  }, [])
  useEffect(() => {
    void window.api.speechQueue().then(setQueue)
    return window.api.onSpeechQueue(setQueue)
  }, [])
  useEffect(() => {
    // 上一次对讲：进页读一次，之后每次链结果都重读（广播本身不带 matchid，只有读口知道属于哪局）。
    const load = (): void => {
      void window.api
        .voiceChainLast()
        .then((last) => {
          setChainLast(last)
          setChainRead(true)
        })
        .catch(() => setChainRead(false))
    }
    load()
    return window.api.onVoiceChainResult(load)
  }, [])
  useEffect(() => {
    // 输入/输出设备只在面板里枚举：插拔后重新打开页面就能看到。
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => {
        setOutputs(all.filter((d) => d.kind === 'audiooutput'))
        setInputs(all.filter((d) => d.kind === 'audioinput'))
      })
      .catch(() => {
        setOutputs([])
        setInputs([])
      })
  }, [])

  // 停止：一句 IPC，主进程把排队清掉、在途标停；回执写成一句话，别让人猜停没停。
  const runStop = useCallback(async () => {
    setQueueBusy(true)
    try {
      const result = await window.api.speechStop()
      setStopNote(stopLine(result))
      setQueue(await window.api.speechQueue())
    } finally {
      setQueueBusy(false)
    }
  }, [])

  const recheckCable = useCallback(() => {
    void window.api.voiceOutCable().then(setCable).catch(() => setCable(null))
  }, [])
  useEffect(() => {
    recheckCable()
  }, [recheckCable])

  // 一键安装：下载解压都归主进程，这里只负责拉起与文案。UAC 与重启必须用户自己点。
  const installCable = useCallback((): void => {
    setInstallingCable(true)
    setLinkNote(null)
    void window.api
      .voiceOutCableInstall()
      .then((result) => {
        setCableGuideOpen(true)
        if (result.launched) setLinkNote('已启动官方安装向导：装完点完成、重启电脑，再回来点「重新检测」')
        else setLinkNote(result.error ?? '安装没走通')
      })
      .catch(() => setLinkNote('安装没走通'))
      .finally(() => setInstallingCable(false))
  }, [])

  // 输出设备清单里的虚拟声卡播放端；选它，声出才进得了游戏的麦克风。
  const cableOutput = findCableOutput(outputs.map((d) => ({ deviceId: d.deviceId, label: d.label })))
  // 解构出 wrap：save 是每次渲染新建的对象字面量，进依赖数组会自激。
  const wrap = save.wrap
  const gap = cable ? judgeCableGap(cable, settings?.ttsOutputDevice ?? '', cableOutput?.deviceId ?? null) : null
  // #90 的初衷（装完就能用）保留，但只保留在用户还没表过态的时候（#183）：
  // 判定在 `planCableAutoSelect()` 里，读起来是一句「chosen 非空就一个字都不写」。
  // 以前这里是「输出不等于 CABLE 就写 CABLE」，注释却写着「用户手动选过别的设备就不碰」——
  // 代码做的正好相反，于是用户有意选的扬声器每次进这一页都被改回去。
  const autoSelect = planCableAutoSelect({
    chosen: settings?.ttsOutputDevice ?? '',
    cableId: cableOutput?.deviceId ?? null,
    error: cable === null ? '检测还没回来' : cable.error,
    installed: cable?.installed ?? false,
    driverOnly: cable?.driverOnly ?? false
  })
  useEffect(() => {
    if (!autoSelect.write) return
    // 「它自己变了」必须有据可查：只在这一处真的写的时候出现一次。
    console.log('CABLE_AUTO_SELECT', JSON.stringify({ from: autoSelect.from, to: autoSelect.to }))
    void wrap(update({ ttsOutputDevice: autoSelect.to }))
    // wrap / update 都是稳定引用；autoSelect 每次渲染新建，所以按两个标量进依赖。
  }, [autoSelect.write, autoSelect.from, autoSelect.to, wrap, update])

  // 纠错回路：改对了就把差异词并进热词表，下一句录音就少错一次。
  const hotwordsRef = useRef(settings?.asrHotwords ?? '')
  hotwordsRef.current = settings?.asrHotwords ?? ''
  const saveCorrection = useCallback(
    (entry: LogEntry): void => {
      const corrected = draft.trim()
      const additions = extractHotwordDiff(entry.transcript, corrected)
      if (additions.length > 0) void update({ asrHotwords: mergeHotwords(hotwordsRef.current, additions) })
      // #66：热词管「下次少错」，样本管「这次已经改对」——原音 + 改对的那句进数据集。
      // 主进程按 utteranceId 取原音（同一句说两遍也不串）；开关也在主进程判（关掉就什么都不写）；
      // 到顶 / 原音已经过期 / 账本没记上时，notice 是唯一让人看见的出口。
      void window.api
        .voiceCorrection({ utteranceId: entry.utteranceId ?? '', corrected })
        .then((result) => setCorrectionNote(result.notice ?? (result.saved ? `已存为纠错样本 ${result.key ?? ''}` : null)))
        .catch((err: unknown) => setCorrectionNote(`纠错样本没存成：${errorMessage(err)}`))
      setLog((l) => l.map((item) => (item.at === entry.at ? { ...item, transcript: corrected, corrected: true } : item)))
      setEditingAt(null)
      setDraft('')
    },
    [draft, update]
  )

  const downloadAsr = async (): Promise<void> => {
    try {
      await window.api.asrDownload()
      setAsrStatus(await window.api.asrStatus())
    } catch (err) {
      setLog((l) => [
        { transcript: '', translated: null, spoken: false, stage: null, error: `${activeEngine?.label ?? '模型'} 下载失败：${errorMessage(err)}`, at: Date.now() },
        ...l
      ])
    }
  }

  const installRuntime = async (): Promise<void> => {
    try {
      await window.api.voiceRuntimeInstall()
      setRuntime(await window.api.voiceRuntimeStatus())
    } catch (err) {
      setLog((l) => [
        { transcript: '', translated: null, spoken: false, stage: null, error: `运行时安装失败：${errorMessage(err)}`, at: Date.now() },
        ...l
      ])
    }
  }

  // 钉一份现役模型：主进程顺手杀掉常驻 worker，下一次录音用新目录重新拉起。
  const chooseModel = async (id: string): Promise<void> => {
    if (!id) return
    setAsrModels(await window.api.asrActiveSet(id))
    setAsrStatus(await window.api.asrStatus())
  }
  const removeModel = async (): Promise<void> => {
    await window.api.voiceModelRemove()
    setAsrStatus(await window.api.asrStatus())
  }
  const runVoiceOutTest = async (): Promise<void> => {
    setOutBusy(true)
    setOutResult(null)
    try {
      setOutResult(await window.api.voiceOutTest())
    } catch (e) {
      setOutResult({ ok: false, durationMs: null, hint: null, sinkLabel: '', error: errorMessage(e) })
    } finally {
      setOutBusy(false)
    }
  }

  // 就绪门：只有声出引擎是 GV 才拦。判断与文案都来自主进程那一份快照，这里只管用。
  // 首屏那一拍快照还没到，算「检查中」而不是「就绪」：否则断链的用户会先看见一个能点的按钮。
  const gvReadiness: VoiceOutReadiness | null = !voiceOutReadinessVisible(settings?.ttsOutEngine)
    ? null
    : (readiness ?? { ready: false, reason: null, line: '正在检查 GV 就绪…', action: null })
  const gate =
    gvReadiness && !gvReadiness.ready ? { locked: true, reason: gvReadiness.line } : { locked: false, reason: '' }
  const action = gvReadiness && !gvReadiness.ready ? gvReadiness.action : null
  // 断链时才给「看这台机器」：就绪时那按钮点进去看不出任何东西（#140）。
  const machineCheck = machineCheckOffer([gvReadiness === null ? null : !gvReadiness.ready])
  const runReadinessAction = (choice: VoiceOutAction): void => {
    // 装引擎要 8GB、装音色包要挑，两件事的家都在音色包弹窗里，按钮只负责把人送到。
    if (choice === 'start-service') void window.api.sovitsStartServer()
    else onOpenVoicePacks?.()
  }

  if (settings === null) {
    return (
      <Panel>
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {loadError ? `读取配置失败：${loadError}` : '读取设置中…'}
        </div>
      </Panel>
    )
  }

  const engine = settings.ttsOutEngine
  const voiceValue =
    engine === 'offline'
      ? OFFLINE_VOICES.some((v) => v.id === settings.ttsOutVoice)
        ? settings.ttsOutVoice
        : OFFLINE_VOICES[0].id
      : VOICE_OUT_VOICES.some((v) => v.id === settings.ttsOutVoice)
        ? settings.ttsOutVoice
        : DEFAULT_VOICE_OUT_VOICE

  const activeModel =
    asrModels === null ? null : (asrModels.models.find((model) => model.id === asrModels.activeId) ?? null)
  const activeEngine = activeModel === null ? null : ASR_ENGINES[activeModel.engineId]
  // 能力行全部从引擎表读：面板不写字面量，加引擎不会忘记改这里。
  const engineHint =
    activeEngine === null
      ? '还没有可用的识别模型：下载一份，或把模型目录放进 asr-models/'
      : [
          activeEngine.note,
          activeEngine.hotwords === 'prompt' ? '支持热词' : '不支持热词',
          activeEngine.punctuation === 'builtin' ? '自带标点' : '无标点',
          activeEngine.finetune === null ? '不可微调' : '可微调',
        ].join('；')

  // 热词只在吃得下的引擎上开放编辑：paraformer 忽略热词，编辑了也是空转（词表保留，切回来就生效）。
  const hotwordsEditable = activeEngine !== null && activeEngine.hotwords === 'prompt'

  // 摘要是整页唯一的一眼：四项当前值 + 每一项的毛病（#174 签字里那条硬要求）。
  const micName = settings.micDevice === '' ? '自动' : deviceLabelOf(inputs.map((d) => ({ deviceId: d.deviceId, label: d.label })), settings.micDevice) || '（未接入）'
  const asrName = activeModel === null ? '识别模型' : activeModel.label
  const asrProblem =
    asrModels === null
      ? '还没读到模型'
      : activeModel === null
        ? '没有现成模型'
        : activeModel.ready
          ? null
          : '未就绪'
  const outProblem =
    cable === null
      ? '虚拟声卡检查中'
      : cable.error !== null
        ? '虚拟声卡没查成'
        : gvReadiness !== null && !gvReadiness.ready
          ? (gvReadiness.reason ?? 'GV 服务没起')
          : null
  const voiceName =
    engine === 'sovits'
      ? (voicePacks.current?.name ?? '音色包没选')
      : ((engine === 'offline' ? OFFLINE_VOICES : VOICE_OUT_VOICES).find((v) => v.id === voiceValue)?.label ?? voiceValue)
  const summary = [
    summaryPart(`讲话 ${micName}`, null),
    summaryPart(`识别 ${asrName}`, asrProblem),
    summaryPart(`声出 ${OUT_ENGINE_LABEL[engine]}`, outProblem),
    summaryPart(`音色 ${voiceName}`, null),
    `语速 ${settings.ttsRate.toFixed(2)}`
  ].join(' · ')

  // 上一次对讲（#167 那份内存快照）：本局才算，跨局与空态各自一句，不互相冒充。
  const chainTiming = chainLast === null ? null : formatChainTiming(chainLast.summary.timing)
  const chainLine = !chainRead
    ? '读不到上一次的记录'
    : chainLast === null
      ? '这局还没对讲过'
      : chainLast.matchid === null
        ? '不在对局里 · 上一次对讲没有对局号'
        : (chainTiming ?? '上一次对讲没有计时（耗时统计关着）')

  return (
    <>
      <Panel>
        {/* 抽屉：装一次就不动的四项收在这里，但那行摘要必须把「现在是什么 + 哪里有毛病」写全。 */}
        <Group label="全部调整">
          <Row
            label="设备与引擎"
            stacked
            hint="点开才展开：讲话设备 / 识别模型 / 运行时 / 说话键、方式 / 热词 / 切段 / 不念谁 / 影子 / 同声 / 三种测试开关"
          >
            <span className="text-xs text-muted-foreground">{summary}</span>
            <Button size="sm" variant="outline" onClick={() => setDrawerOpen((open) => !open)}>
              {drawerOpen ? '收起' : '全部调整'}
            </Button>
          </Row>
          {drawerOpen ? (
            <div className="border-t border-border/60">
              <DrawerRow label="识别模型" hint="底模按文件下载，微调转正的优先生效">
                {!asrStatus ? (
                  <StatusPill tone="idle">检查中…</StatusPill>
                ) : asrStatus.ready ? (
                  <>
                    <StatusPill tone="ready">已就绪 {Math.round(asrStatus.bytes / 1024 / 1024)} MB</StatusPill>
                    {activeModel?.origin === 'download' || activeModel?.origin === 'manual' ? (
                      <Button size="sm" variant="outline" onClick={() => void removeModel()}>
                        删除模型
                      </Button>
                    ) : null}
                  </>
                ) : asrStatus.downloading ? (
                  <StatusPill tone="warn">{asrStatus.verifying ? '校验中…' : `下载中 ${Math.round(asrStatus.progress * 100)}%`}</StatusPill>
                ) : (
                  <>
                    <StatusPill tone={asrStatus.error ? 'bad' : 'idle'}>{asrStatus.error ?? '模型未下载'}</StatusPill>
                    <Button size="sm" variant="outline" onClick={() => void downloadAsr()}>
                      下载模型
                    </Button>
                  </>
                )}
              </DrawerRow>
              <DrawerRow label="语音运行时" hint="独立 node.exe + sherpa 插件，约 35 MB">
                {!runtime ? (
                  <StatusPill tone="idle">检查中…</StatusPill>
                ) : runtime.installing ? (
                  <StatusPill tone="warn">安装中…</StatusPill>
                ) : runtime.state === 'ready' ? (
                  <StatusPill tone="ready">已就绪</StatusPill>
                ) : (
                  <>
                    <StatusPill tone={runtime.installError ? 'bad' : 'idle'}>
                      {runtime.installError ?? (runtime.state === 'broken' ? '安装不完整' : '未安装')}
                    </StatusPill>
                    <Button size="sm" variant="outline" onClick={() => void installRuntime()}>
                      {runtime.state === 'broken' ? '重试安装' : '安装运行时'}
                    </Button>
                  </>
                )}
              </DrawerRow>
              <DrawerRow label="说话键 / 方式" hint="游戏里按住才能发言的键；方式要和游戏设置一致">
                <Input
                  id="v2-speakKey"
                  className="w-24 font-mono"
                  value={settings.ttsSpeakKey}
                  onChange={(e) => update({ ttsSpeakKey: e.target.value.toUpperCase() })}
                  placeholder="F5"
                />
                <Button
                  size="sm"
                  variant={settings.ttsSpeakMode === 'hold' ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ ttsSpeakMode: 'hold' }))}
                >
                  按住（{settings.ttsSpeakMode === 'hold' ? '现在' : '切换'}）
                </Button>
                <Button
                  size="sm"
                  variant={settings.ttsSpeakMode === 'toggle' ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ ttsSpeakMode: 'toggle' }))}
                >
                  敲一下（{settings.ttsSpeakMode === 'toggle' ? '现在' : '切换'}）
                </Button>
              </DrawerRow>
              <DrawerRow
                label="热词"
                hint={
                  activeEngine === null
                    ? '还没有现役识别模型：先在上面选一个'
                    : hotwordsEditable
                      ? '填容易认错的词，下一句录音就生效'
                      : '当前引擎忽略热词：词表保留，换回支持热词的引擎就恢复'
                }
              >
                <HotwordEditor
                  value={settings.asrHotwords}
                  disabled={!hotwordsEditable}
                  onChange={(next) => void update({ asrHotwords: next })}
                />
              </DrawerRow>
              <HotwordCandidateBox enabled={hotwordsEditable} onApplied={(next) => void update({ asrHotwords: next })} />
              <DrawerRow label="切段策略" hint={splitPreviewLine(previewSplit(SPLIT_SAMPLE, settings.speechSplitStrategy, settings.ttsSpeakSegmentChars ?? 30))}>
                <select
                  id="v2-splitStrategy"
                  value={settings.speechSplitStrategy}
                  onChange={(e) =>
                    void save.wrap(update({ speechSplitStrategy: e.target.value as (typeof SPEECH_SPLIT_STRATEGIES)[number] }))
                  }
                  className={selectClass}
                >
                  {SPEECH_SPLIT_STRATEGIES.map((one) => (
                    <option key={one} value={one}>
                      {SPEECH_SPLIT_LABELS[one]}
                    </option>
                  ))}
                </select>
              </DrawerRow>
              <DrawerRow
                label="不念谁"
                hint={
                  muteLine(muteTableOf({ muteHeroes: settings.ttsMuteHeroes ?? [], muteNames: settings.ttsMuteNames ?? [] })) +
                  ' · 英雄短名（影魔 nevermore）或昵称/座位名；逗号分隔'
                }
              >
                <Input
                  id="v2-muteNames"
                  defaultValue={formatMuteList([...(settings.ttsMuteNames ?? []), ...(settings.ttsMuteHeroes ?? [])])}
                  onBlur={(e) => {
                    // 一个词可能既是昵称又是英雄短名，两路都写进去；命中任一路就跳过这个人。
                    const list = parseMuteList(e.target.value)
                    void save.wrap(update({ ttsMuteNames: list, ttsMuteHeroes: list }))
                  }}
                  placeholder="例：玩家2、nevermore"
                />
              </DrawerRow>
              {shadow ? (
                <DrawerRow label="影子模式" hint="第一局先不出声：照常翻译、记账，但不合成、不按说话键">
                  <StatusPill tone={shadow.state === 'active' ? 'warn' : shadow.state === 'done' ? 'ready' : 'idle'}>
                    {shadow.state === 'active' ? '第一局只记账' : shadow.state === 'done' ? '已完成' : '未启用'}
                  </StatusPill>
                  <span className="text-xs text-muted-foreground">{shadow.line}</span>
                </DrawerRow>
              ) : null}
              <DrawerRow label="本机也播放" hint="调试用：译文同时播到系统默认扬声器">
                <Button
                  size="sm"
                  variant={settings.ttsMonitorLocal ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ ttsMonitorLocal: !settings.ttsMonitorLocal }))}
                >
                  {settings.ttsMonitorLocal ? '开（本机也能听到）' : '关'}
                </Button>
              </DrawerRow>
              <DrawerRow
                label="同声翻译"
                hint={
                  settings.interpretInDevice === ''
                    ? interpretFollowNote(deviceLabelOf(outputs, settings.ttsOutputDevice))
                    : interpretDeviceLine(deviceLabelOf(outputs, settings.interpretInDevice))
                }
              >
                <Button
                  size="sm"
                  variant={settings.interpretMode ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ interpretMode: !settings.interpretMode }))}
                >
                  {settings.interpretMode ? '开' : '关'}
                </Button>
                <select
                  id="v2-interpretDevice"
                  value={settings.interpretInDevice}
                  onChange={(e) => void save.wrap(update({ interpretInDevice: e.target.value }))}
                  className={`${selectClass} max-w-72`}
                  disabled={!settings.interpretMode}
                >
                  <option value="">跟输出设备</option>
                  {outputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `输出设备 ${d.deviceId.slice(0, 8)}…`}
                    </option>
                  ))}
                  {settings.interpretInDevice && !outputs.some((d) => d.deviceId === settings.interpretInDevice) ? (
                    <option value={settings.interpretInDevice}>（已保存，当前未接入）</option>
                  ) : null}
                </select>
              </DrawerRow>
              <DrawerRow label="三种测试开关" hint="只放音频 / 只看识别 / 记耗时；测完记得关">
                <Button
                  size="sm"
                  variant={settings.voiceOutTestMode ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ voiceOutTestMode: !settings.voiceOutTestMode }))}
                >
                  测试模式（{settings.voiceOutTestMode ? '开' : '关'}）
                </Button>
                <Button
                  size="sm"
                  variant={settings.voiceTranscribeOnly ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ voiceTranscribeOnly: !settings.voiceTranscribeOnly }))}
                >
                  只看识别（{settings.voiceTranscribeOnly ? '开' : '关'}）
                </Button>
                <Button
                  size="sm"
                  variant={settings.voiceShowTiming ? 'secondary' : 'outline'}
                  onClick={() => void save.wrap(update({ voiceShowTiming: !settings.voiceShowTiming }))}
                >
                  耗时统计（{settings.voiceShowTiming ? '开' : '关'}）
                </Button>
              </DrawerRow>
            </div>
          ) : null}
        </Group>

        <Group label="听">
          <Row
            label="讲话设备"
            htmlFor="v2-micDevice"
            hint="语音对讲从哪收声。蓝牙耳机的麦克风会让 Windows 把耳机切到通话模式——游戏声音断一两秒再回来，之后变闷；要一边听游戏一边说话，选内置的「麦克风阵列」。"
          >
            <select
              id="v2-micDevice"
              value={settings.micDevice}
              onChange={(e) => void save.wrap(update({ micDevice: e.target.value }))}
              className={`${selectClass} max-w-72`}
            >
              <option value="">自动（先挑真麦克风，跳过虚拟声卡）</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `输入设备 ${d.deviceId.slice(0, 8)}…`}
                </option>
              ))}
              {settings.micDevice && !inputs.some((d) => d.deviceId === settings.micDevice) ? (
                <option value={settings.micDevice}>（已保存，当前未接入）</option>
              ) : null}
            </select>
          </Row>
          <Row label="麦克风电平" stacked hint="录着的时候跟着声音走；设备掉了这里立刻报，下一次开麦自动回退到默认设备。">
            {micHealth?.recording ? (
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-40 overflow-hidden rounded bg-muted">
                  <span
                    className="block h-full rounded bg-emerald-400 transition-[width] duration-100"
                    style={{ width: `${micHealth.level}%` }}
                  />
                </span>
                <span className="text-xs text-muted-foreground">{micHealth.level}%</span>
              </span>
            ) : micHealth?.dead ? (
              <StatusPill tone="warn">设备没声音</StatusPill>
            ) : (
              <StatusPill tone="idle">空闲</StatusPill>
            )}
          </Row>
          <Row label="识别引擎" stacked hint={engineHint}>
            <select
              className={selectClass}
              value={asrModels?.activeId ?? ''}
              onChange={(e) => void chooseModel(e.target.value)}
            >
              {(asrModels?.models ?? []).map((model) => (
                <option key={model.id} value={model.id} disabled={!model.ready}>
                  {model.label}
                  {model.ready ? '' : '（未就绪）'}
                </option>
              ))}
            </select>
            {asrModels !== null && asrModels.pinned ? null : <StatusPill tone="idle">自动</StatusPill>}
          </Row>
        </Group>

        <Group label="说">
          <Row
            label="声出引擎"
            htmlFor="v2-outEngine"
            hint={
              engine === 'sovits'
                ? '音色包是全局的：声出和朗读共用一个，换了两边一起变'
                : engine === 'offline'
                  ? '离线模型是中文嗓，念英文会吞字——只用来验证链路'
                  : '免费端点的英文神经嗓；合成失败这句静默跳过，绝不回退系统嗓子'
            }
          >
            <select
              id="v2-outEngine"
              value={engine}
              onChange={(e) => void save.wrap(update({ ttsOutEngine: e.target.value as VoiceOutEngine }))}
              className={selectClass}
            >
              <option value="edge">Edge · 英文神经嗓</option>
              <option value="offline">离线 · 本地模型</option>
              <option value="sovits">GV · GPT-SoVITS 音色包</option>
            </select>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row label="声出音色" htmlFor="v2-outVoice">
            {engine === 'sovits' ? (
              <VoicePackDisplay
                current={voicePacks.current}
                error={voicePacks.error}
                onOpenVoicePacks={onOpenVoicePacks}
              />
            ) : (
              <select
                id="v2-outVoice"
                value={voiceValue}
                onChange={(e) => void save.wrap(update({ ttsOutVoice: e.target.value }))}
                className={selectClass}
              >
                {(engine === 'offline' ? OFFLINE_VOICES : VOICE_OUT_VOICES).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                    {'note' in v && v.note ? ` · ${v.note}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Row>
          <Row
            label="虚拟声卡"
            hint="声出要进 Dota 2 语音：译文播到 CABLE Input，游戏里麦克风选 CABLE Output"
            note={
              cable === null ? (
                <span className="text-muted-foreground">检查中…</span>
              ) : (
                <span className={gap!.action === 'none' ? 'text-muted-foreground' : 'text-amber-400'}>{gap!.line}</span>
              )
            }
          >
            <Button size="sm" variant="outline" onClick={recheckCable}>
              重新检测
            </Button>
            {cable && gap!.action === 'install-cable' ? (
              <>
                <Button size="sm" variant="secondary" disabled={installingCable} onClick={installCable}>
                  {installingCable ? '准备中…' : '一键安装'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setCableGuideOpen(true)}>
                  怎么装…
                </Button>
              </>
            ) : null}
            {cable && gap!.action === 'select-device' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void save.wrap(update({ ttsOutputDevice: cableOutput?.deviceId ?? '' }))}
              >
                {gap!.actionLabel}
              </Button>
            ) : null}
          </Row>
          <Row label="输出设备" htmlFor="v2-outDevice" hint="选 VB-Cable 的「CABLE Input」；找不到已选设备时回退系统默认并提示">
            <select
              id="v2-outDevice"
              value={settings.ttsOutputDevice}
              onChange={(e) => void save.wrap(update({ ttsOutputDevice: e.target.value }))}
              className={`${selectClass} max-w-72`}
            >
              <option value="">系统默认输出</option>
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `输出设备 ${d.deviceId.slice(0, 8)}…`}
                </option>
              ))}
              {settings.ttsOutputDevice && !outputs.some((d) => d.deviceId === settings.ttsOutputDevice) ? (
                <option value={settings.ttsOutputDevice}>（已保存，当前未接入）</option>
              ) : null}
            </select>
          </Row>
          <Row label="整条链" hint="点一下开始说话，再点一下结束：识别 → 翻译 → 声出全程照跑">
            <Button
              size="sm"
              variant={recording ? 'secondary' : 'outline'}
              onClick={() => void window.api.overlayVoiceToggle()}
            >
              {recording ? '● 录音中 · 再点结束' : '说一句试试'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={outBusy || gate.locked}
              onClick={() => void runVoiceOutTest()}
            >
              测试声出
            </Button>
            {outResult ? (
              <StatusPill tone={outResult.ok ? 'ready' : 'bad'}>
                {outResult.ok
                  ? `通过${outResult.durationMs ? ` · ${(outResult.durationMs / 1000).toFixed(1)} 秒` : ''}`
                  : outResult.error ?? '声出失败'}
              </StatusPill>
            ) : null}
            {outResult?.sinkLabel ? (
              <span
                className={`text-xs ${isVirtualCableName(outResult.sinkLabel) ? 'text-muted-foreground' : 'text-amber-400'}`}
              >
                {isVirtualCableName(outResult.sinkLabel)
                  ? `已播到 ${outResult.sinkLabel}`
                  : `播到 ${outResult.sinkLabel}（不是虚拟声卡，队友听不到）`}
              </span>
            ) : null}
            {recording ? <span className="text-xs text-amber-400">● 正在录音，说完再点一次</span> : null}
          </Row>
          {gvReadiness ? (
            <Row
              label="GV 就绪"
              hint={gate.locked ? gate.reason : '引擎 → 音色包 → 服务 → 参考音频，缺哪一环就说哪一环'}
            >
              {/* 就绪是常态，不铺颜色；断链才是要拦人的事，用警告色说清楚缺什么。 */}
              <span className={gvReadiness.ready ? 'text-xs text-zinc-400' : 'text-xs text-amber-400'}>
                {gvReadiness.line}
              </span>
              {action ? (
                <Button size="sm" variant="outline" onClick={() => runReadinessAction(action)}>
                  {READINESS_ACTION_LABEL[action]}
                </Button>
              ) : null}
              {machineCheck.show && onOpenMachineCheck ? (
                <Button size="sm" variant="ghost" onClick={onOpenMachineCheck}>
                  {machineCheck.label}
                </Button>
              ) : null}
            </Row>
          ) : null}
        </Group>

        {/* #88：队列真相在主进程（speech-pipeline 握着 lanes 与在途的段），面板只画快照，不自己数。 */}
        <Group label="队列与记录">
          <Row label="正在读" stacked hint="正在读哪一句、后头还压着几句；停止 = 排队的当场清掉，正在读的读到当前段的段尾就停。">
            {queue ? (
              <>
                <StatusPill tone={queue.pending > 0 ? 'warn' : 'ready'}>{queueLine(queue)}</StatusPill>
                <Button size="sm" variant="outline" disabled={queueBusy} onClick={() => void runStop()}>
                  {queueBusy ? '停止中…' : '停止'}
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">还在读队列</span>
            )}
          </Row>
          {stopNote ? <p className="px-4 pb-3 text-xs text-muted-foreground">{stopNote}</p> : null}
          <Row
            label="积压策略"
            hint="开：新的一句来了，就把它之前还没开口的几句直接跳过——刷新太快时中间的句子会丢，只保证你听到的是最新战况。关：一句不落，按顺序念完。"
          >
            <Button
              size="sm"
              variant={settings.ttsDropBacklog ? 'secondary' : 'outline'}
              onClick={() => void save.wrap(update({ ttsDropBacklog: !settings.ttsDropBacklog }))}
            >
              {settings.ttsDropBacklog ? '开（丢旧的，只念最新的）' : '关（排着队念完）'}
            </Button>
          </Row>
          <Row label="上一次对讲" hint={chainLine}>
            {chainLast?.matchid ? (
              <span className="text-xs text-muted-foreground">对局 {chainLast.matchid}</span>
            ) : null}
          </Row>
        </Group>

        {log.length > 0 ? (
          <Group label="识别记录">
            <ul className="space-y-1.5 px-4 py-3">
              {log.map((entry) => (
                <li key={entry.at} className="min-w-0 text-xs leading-5">
                  <span className="mr-2 tabular-nums text-muted-foreground">
                    {new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                  {entry.error ? (
                    <span className="text-rose-400">🎤 {entry.error}</span>
                  ) : editingAt === entry.at ? (
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <Input
                        className="h-6 min-w-0 flex-1 text-xs"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveCorrection(entry)
                          if (e.key === 'Escape') {
                            setEditingAt(null)
                            setDraft('')
                          }
                        }}
                      />
                      <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={() => saveCorrection(entry)}>
                        存（差异并入热词）
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 px-2 text-xs"
                        onClick={() => {
                          setEditingAt(null)
                          setDraft('')
                        }}
                      >
                        取消
                      </Button>
                    </span>
                  ) : (
                    <span className="min-w-0">
                      {entry.corrected ? '✏️ ' : ''}🎤 原文「{entry.transcript || '（空）'}」→ 译文「
                      {entry.translated ?? (entry.stage === 'skipped' ? '（只看识别）' : '（翻译失败）')}」
                      {entry.stage === 'skipped' ? '' : entry.spoken ? ' · 已播放' : ' · 未播放'}
                      {entry.sink ? ` · 灌入「${entry.sink}」` : ''}{' '}
                      {entry.timing ? (
                        <span className="mr-1 text-muted-foreground" title="一次对讲的分段耗时：识别 → 译 → 首音 → 起播 → 播完">
                          {formatChainTiming(entry.timing)}
                        </span>
                      ) : null}
                      {entry.transcript ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-xs text-muted-foreground"
                          title={`${activeEngine?.hotwords === 'prompt' ? '改成对的：差异词自动并入热词表。' : '改成对的：差异词不并入热词表（当前引擎不支持热词提示）。'}${settings?.asrCorrectionsToDataset ? '原始录音同时存成纠错样本（识别训练里可关）。' : ''}`}
                          onClick={() => {
                            setEditingAt(entry.at)
                            setDraft(entry.transcript)
                          }}
                        >
                          纠错
                        </Button>
                      ) : null}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {correctionNote ? (
              <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">{correctionNote}</p>
            ) : null}
          </Group>
        ) : null}
      </Panel>


      <Modal
        open={cableGuideOpen}
        title="让声出进 Dota 2 语音：装 VB-Cable"
        hint="VB-Cable 是一块虚拟声卡：把声出的译文接进游戏麦克风，不改游戏文件"
        onClose={() => setCableGuideOpen(false)}
      >
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>点「一键安装」：自动下载并打开官方安装器；UAC 问一次，走完向导后重启一次电脑。</li>
            <li>Dota 2：设置 → 音频 → 语音输入设备，选 CABLE Output (VB-Audio Virtual Cable)。</li>
            <li>本页「输出设备」选 CABLE Input (VB-Audio Virtual Cable)。</li>
            <li>按一次说话键，确认「测试声出」显示已播到 CABLE Input。</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            注意：输出设备指向虚拟声卡后，本机扬声器就听不到译文了；要自己听，把输出设备切回扬声器即可。
          </p>
          {linkNote ? <p className="text-xs text-amber-400">{linkNote}</p> : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void window.api
                  .appOpenExternal('https://vb-audio.com/Cable/')
                  .then((r) => setLinkNote(r.ok ? null : r.error))
              }
            >
              打开下载页
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCableGuideOpen(false)
                recheckCable()
              }}
            >
              重新检测
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
