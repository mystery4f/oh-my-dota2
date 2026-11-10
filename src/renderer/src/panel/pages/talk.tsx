import { useCallback, useEffect, useRef, useState } from 'react'
import {
  OFFLINE_VOICES,
  type OfflineStatus,
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
  type VirtualCableStatus
} from '@shared/voice-out'
import { extractHotwordDiff, mergeHotwords } from '@shared/asr-hotwords'
import { formatChainTiming } from '@shared/voice-timing'
import { ASR_ENGINES } from '@shared/asr/engines'
import type { AsrState } from '@shared/asr/models'
import {
  voiceOutReadinessVisible,
  type VoiceOutAction,
  type VoiceOutReadiness
} from '@shared/voice-out-readiness'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CollapsibleGroup, Group, Panel, Row, SaveFlash, StatusPill } from '../components/primitives'
import { selectClass } from '../components/select-class'
import { Modal } from '../components/modal'
import { errorMessage } from '@shared/errors'
import { HotwordEditor } from '../components/hotword-editor'
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


/**
 * 对讲页：我说给别人听。麦克风 → 识别 → 翻译 → 声出，一条链一屏看完。
 * 声出用哪个音色包也在这里显示，但换包走弹窗——下载/删除/服务不属于这一页的常规流程。
 */
export function TalkPage({
  onOpenVoicePacks
}: {
  /** 打开音色包弹窗（与朗读页同一个）。 */
  onOpenVoicePacks?: () => void
}): React.ReactElement {
  const { settings, update, loadError } = useSettings()
  const save = useSaveFlash()
  // 声出走 GV 时才需要报出当前音色包；换包本身在弹窗里，这里只读。
  const voicePacks = useVoicePacks(settings?.ttsOutEngine === 'sovits')

  const [asrStatus, setAsrStatus] = useState<OfflineStatus | null>(null)
  // 模型注册表：换模型只是换一个 id，面板因此不需要知道有几种引擎存在。
  const [asrModels, setAsrModels] = useState<AsrState | null>(null)
  const [runtime, setRuntime] = useState<VoiceRuntimeStatus | null>(null)
  const [outBusy, setOutBusy] = useState(false)
  const [outResult, setOutResult] = useState<VoiceOutTestResult | null>(null)
  // 声出就绪快照：进页读一次，之后主进程只在变化时推（面板不自己开定时器）。
  const [readiness, setReadiness] = useState<VoiceOutReadiness | null>(null)
  const [recording, setRecording] = useState(false)
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
  return (
    <>
      <Panel>
        <Group label="怎么听">
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
          <Row label="语音运行时" hint="识别跑在独立的 node.exe + sherpa 插件里（sherpa 原生插件进不了 Electron）；一键装到数据目录，约 35 MB">
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
          </Row>
          <Row label="说话键" htmlFor="v2-speakKey" hint="游戏里按住才能发言的那个键：声出时由程序按住它把话送进频道">
            <Input
              id="v2-speakKey"
              className="w-24 font-mono"
              value={settings.ttsSpeakKey}
              onChange={(e) => update({ ttsSpeakKey: e.target.value.toUpperCase() })}
              placeholder="F5"
            />
          </Row>
          <Row
            label="说话方式"
            hint="要和游戏里语音按键的设置一致：按住 = 游戏选「按住说话」；敲一下 = 游戏选「切换」，按一下开麦、播完再按一下关麦"
          >
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={settings.ttsSpeakMode === 'hold' ? 'secondary' : 'outline'}
                onClick={() => void save.wrap(update({ ttsSpeakMode: 'hold' }))}
              >
                按住
              </Button>
              <Button
                size="sm"
                variant={settings.ttsSpeakMode === 'toggle' ? 'secondary' : 'outline'}
                onClick={() => void save.wrap(update({ ttsSpeakMode: 'toggle' }))}
              >
                敲一下
              </Button>
            </div>
          </Row>
          <Row
            label="热词"
            stacked
            hint={
              activeEngine === null
                ? '还没有现役识别模型：先在上方选一个，再回来编辑热词'
                : hotwordsEditable
                  ? '填容易认错的词，下一句录音就生效；识别记录里点「纠错」，差异词会自动并进这里。'
                  : '当前引擎忽略热词：词表原样保留，换回支持热词的引擎就恢复编辑与生效。'
            }
          >
            <HotwordEditor
              value={settings.asrHotwords}
              disabled={!hotwordsEditable}
              onChange={(next) => void update({ asrHotwords: next })}
            />
          </Row>
          <Row label="识别模型" hint="现役模型的下载与删除：底模从 hf-mirror 按文件下载（断点续传 + 校验）；微调转正的模型优先生效">
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
                <StatusPill tone={asrStatus.error ? 'bad' : 'idle'}>
                  {asrStatus.error ?? '模型未下载'}
                </StatusPill>
                <Button size="sm" variant="outline" onClick={() => void downloadAsr()}>
                  下载模型
                </Button>
              </>
            )}
          </Row>
        </Group>

        <Group label="说给谁听">
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
          >
            {cable === null ? (
              <span className="text-xs text-muted-foreground">检查中…</span>
            ) : cable.error !== null ? (
              <span className="text-xs text-amber-400">没查成：{cable.error}</span>
            ) : !cable.installed ? (
              <span className="text-xs text-amber-400">没检测到 VB-Cable：声出只会从扬声器出来，队友听不到</span>
            ) : cable.driverOnly ? (
              <span className="text-xs text-amber-400">驱动在，音频端点还没出现：重启一次再检测</span>
            ) : (
              <span className="text-xs text-muted-foreground">已装：{cable.endpoints.join(' / ')}</span>
            )}
            <Button size="sm" variant="outline" onClick={recheckCable}>
              重新检测
            </Button>
            {cable && cable.error === null && (!cable.installed || cable.driverOnly) ? (
              <Button size="sm" variant="secondary" onClick={() => setCableGuideOpen(true)}>
                怎么装…
              </Button>
            ) : null}
            {cable && cable.error === null && !cable.installed ? (
              <Button size="sm" variant="secondary" disabled={installingCable} onClick={installCable}>
                {installingCable ? '准备中…' : '一键安装'}
              </Button>
            ) : null}
            {cableOutput && settings.ttsOutputDevice !== cableOutput.deviceId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void save.wrap(update({ ttsOutputDevice: cableOutput.deviceId }))}
              >
                设为输出
              </Button>
            ) : null}
          </Row>
          <Row label="本机也播放" hint="调试用：译文同时播到系统默认扬声器；正式用时关掉，本机就只剩游戏里能听到">
            <Button
              size="sm"
              variant={settings.ttsMonitorLocal ? 'secondary' : 'outline'}
              onClick={() => void save.wrap(update({ ttsMonitorLocal: !settings.ttsMonitorLocal }))}
            >
              {settings.ttsMonitorLocal ? '开（本机也能听到）' : '关'}
            </Button>
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
        </Group>

        <Group label="试一下">
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
            </Row>
          ) : null}
          <Row label="测试模式" hint="只放音频、不按说话键：游戏没开也能试听">
            <Button
              size="sm"
              variant={settings.voiceOutTestMode ? 'secondary' : 'outline'}
              onClick={() => void save.wrap(update({ voiceOutTestMode: !settings.voiceOutTestMode }))}
            >
              {settings.voiceOutTestMode ? '开（不按说话键）' : '关'}
            </Button>
          </Row>
          <Row label="只看识别" hint="转写完就停：不翻译、不声出——测口音、调模型用，测完记得关">
            <Button
              size="sm"
              variant={settings.voiceTranscribeOnly ? 'secondary' : 'outline'}
              onClick={() => void save.wrap(update({ voiceTranscribeOnly: !settings.voiceTranscribeOnly }))}
            >
              {settings.voiceTranscribeOnly ? '开（不翻译不声出）' : '关'}
            </Button>
          </Row>
          <Row label="耗时统计" hint="识别/译/首音/起播/播完各段多久：浮层与识别记录里都能看到；默认关">
            <Button
              size="sm"
              variant={settings.voiceShowTiming ? 'secondary' : 'outline'}
              onClick={() => void save.wrap(update({ voiceShowTiming: !settings.voiceShowTiming }))}
            >
              {settings.voiceShowTiming ? '开' : '关'}
            </Button>
          </Row>
        </Group>

        {log.length > 0 ? (
          <Group label="识别记录">
            <ul className="space-y-1.5 px-4 py-3">
              {log.map((entry) => (
                <li key={entry.at} className="text-xs leading-5">
                  <span className="mr-2 tabular-nums text-muted-foreground">
                    {new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                  {entry.error ? (
                    <span className="text-rose-400">🎤 {entry.error}</span>
                  ) : editingAt === entry.at ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Input
                        className="h-6 w-64 text-xs"
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
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => saveCorrection(entry)}>
                        存（差异并入热词）
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          setEditingAt(null)
                          setDraft('')
                        }}
                      >
                        取消
                      </Button>
                    </span>
                  ) : (
                    <span>
                      {entry.corrected ? '✏️ ' : ''}🎤 原文「{entry.transcript || '（空）'}」→ 译文「
                      {entry.translated ?? (entry.stage === 'skipped' ? '（只看识别）' : '（翻译失败）')}」
                      {entry.stage === 'skipped' ? '' : entry.spoken ? ' · 已播放' : ' · 未播放'}{' '}
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


      <CollapsibleGroup id="talk.train" label="训练">
        <Row
          label="音色训练 / 识别训练"
          hint="GV 音色微调与 ASR 口音微调都在侧边栏「系统」组下，训练记录会留在磁盘上"
        >
          <StatusPill tone="idle">侧边栏</StatusPill>
        </Row>
      </CollapsibleGroup>

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
