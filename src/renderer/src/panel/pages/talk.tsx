import { useCallback, useEffect, useRef, useState } from 'react'
import {
  OFFLINE_VOICES,
  type OfflineStatus,
  type VoiceChainSummary,
  type VoiceOutEngine,
  type VoiceOutTestResult,
  type VoiceRuntimeStatus
} from '@shared/ipc'
import { DEFAULT_VOICE_OUT_VOICE, VOICE_OUT_VOICES } from '@shared/voice-out'
import { extractHotwordDiff, mergeHotwords } from '@shared/asr-hotwords'
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
import { errorMessage } from '@shared/errors'
import { useSaveFlash, useSettings } from '../use-settings'
import { useVoicePacks } from '../use-voice-packs'
import { VoicePackDisplay } from '../components/voice-pack-display'

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
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])

  // Qwen3 模型状态：进面板问一次，解压期间每秒刷——别让人对着假进度等。
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
    // 输出设备只在面板里枚举：插拔后重新打开页面就能看到。
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setOutputs(all.filter((d) => d.kind === 'audiooutput')))
      .catch(() => setOutputs([]))
  }, [])

  // 纠错回路：改对了就把差异词并进热词表，下一句录音就少错一次。
  const hotwordsRef = useRef(settings?.asrHotwords ?? '')
  hotwordsRef.current = settings?.asrHotwords ?? ''
  const saveCorrection = useCallback(
    (entry: LogEntry): void => {
      const additions = extractHotwordDiff(entry.transcript, draft)
      if (additions.length > 0) void update({ asrHotwords: mergeHotwords(hotwordsRef.current, additions) })
      setLog((l) => l.map((item) => (item.at === entry.at ? { ...item, transcript: draft.trim(), corrected: true } : item)))
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
        { transcript: '', translated: null, spoken: false, stage: null, error: `Qwen3 解压失败：${errorMessage(err)}`, at: Date.now() },
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
      setOutResult({ ok: false, durationMs: null, hint: null, error: errorMessage(e) })
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

  return (
    <>
      <Panel>
        <Group label="怎么听">
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
            label="热词"
            htmlFor="v2-hotwords"
            stacked
            hint="填容易认错的词，下一句录音就生效；识别记录里点「纠错」，差异词会自动并进这里。"
          >
            <Input
              id="v2-hotwords"
              value={settings.asrHotwords}
              onChange={(e) => update({ asrHotwords: e.target.value })}
              placeholder="肉山, 买活, 风暴之灵"
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
                      {entry.transcript ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-xs text-muted-foreground"
                          title="改成对的，差异词自动并入热词表（仅 Qwen3）"
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
    </>
  )
}
