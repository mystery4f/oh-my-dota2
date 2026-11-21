import { useEffect, useState } from 'react'
import {
  OFFLINE_VOICES,
  type OfflineStatus,
  type OfflineVoiceId,
  type VoicePreviewResult
} from '@shared/ipc'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES } from '@shared/tts-voices'
import { offlineUiView } from '@shared/offline-status'
import type { SpeakerChannels } from '@shared/speaker-channel'
import { formatMegabytes } from '@shared/first-run'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Group, Panel, Row, SaveFlash, StatusPill } from '../components/primitives'
import { errorMessage } from '@shared/errors'
import { selectClass } from '../components/select-class'
import { useSaveFlash, useSettings } from '../use-settings'
import { useVoicePacks } from '../use-voice-packs'
import { VoicePackDisplay } from '../components/voice-pack-display'

type TtsEngine = 'system' | 'edge' | 'offline' | 'sovits'
type SpeakPrefix = 'front' | 'back' | 'off'

const PREVIEW_LINE = '小心，他们可能在打肉山，快回来'

/** 对局播报的逐条开关：顺序就是面板上的顺序，语义在 @shared/dota-announce。 */
const ANNOUNCE_ROWS = [
  { id: 'wisdom', label: '智慧符', hint: '每 7 分钟刷一次的那对，报「下路」这种位置' },
  { id: 'rosh', label: '肉山', hint: '击杀后按复活倒计时报一次' },
  { id: 'stack', label: '堆野', hint: '野区整点前提醒该去堆野了' },
  { id: 'pull', label: '拉野', hint: '兵线要压过去时提醒拉野' }
] as const

/** 不念谁那一行的说明：座位写法只认 `voice:speaker-channels`，一行都认不出就直说。 */
function muteLineOf(channels: SpeakerChannels | null): string {
  if (channels === null) return '读取这一局的座位…'
  if (channels.channels.length === 0) return '这局还没人说话'
  if (channels.channels.every((one) => one.hero === null)) return '这一局认不出谁是谁'
  return channels.channels.map((one) => one.label).join('、')
}

/** 朗读页：我听别人说。念不念念谁、对局播报、嗓子、说法模板四块。 */
export function ReadPage({
  onOpenVoicePacks,
  onOpenMuteList
}: {
  /** 打开音色包弹窗：下载、删除、参考音频、GV 服务都在那里，这一行只负责选。 */
  onOpenVoicePacks?: () => void
  /** 跳到逐人静音名单的编辑处：这一页不重复放一份编辑。 */
  onOpenMuteList?: () => void
}): React.ReactElement {
  const { settings, update, loadError } = useSettings()
  const save = useSaveFlash()
  const [offline, setOffline] = useState<OfflineStatus | null>(null)
  const [channels, setChannels] = useState<SpeakerChannels | null>(null)
  const [preview, setPreview] = useState<{ busy: boolean; result: VoicePreviewResult | null }>({
    busy: false,
    result: null
  })
  useEffect(() => {
    void window.api.ttsOfflineState().then(setOffline)
    void window.api.speakerChannels().then(setChannels)
  }, [])

  // 只有真选了 GV 引擎才去拉清单：取数、轮询、装包、选用全在 useVoicePacks 里。
  const voicePacks = useVoicePacks(settings?.ttsEngine === 'sovits')

  const runPreview = (): void => {
    setPreview({ busy: true, result: null })
    void window.api
      .ttsPreview(PREVIEW_LINE)
      .then((result) => {
        setPreview({ busy: false, result })
        if (result.ok && result.audioBase64) {
          const audio = new Audio(
            `data:${result.audioMime ?? 'audio/mp3'};base64,${result.audioBase64}`
          )
          void audio.play()
        }
      })
      .catch((e: unknown) => {
        setPreview({ busy: false, result: { ok: false, error: errorMessage(e) } })
      })
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

  const engine = settings.ttsEngine
  const currentPack = voicePacks.current
  const offlineView = offlineUiView({
    ready: offline?.ready ?? false,
    downloading: offline?.downloading ?? false,
    bytes: offline?.bytes ?? null,
    error: offline?.error ?? null
  })
  const offlineTone =
    offlineView.state === 'ready'
      ? 'ready'
      : offlineView.state === 'failed'
        ? 'bad'
        : offlineView.state === 'downloading'
          ? 'warn'
          : 'idle'
  const announce = settings.announceTotal

  return (
    <>
      <Panel>
        <Group label="念不念念谁">
          <Row
            label="念出别人打的中文"
            hint="关掉之后整局都不念，包括队友的喊话；反方向（你说、别人听）在「它怎么听 · 说」"
          >
            <Button
              variant={settings.ttsReadAloud ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => void save.wrap(update({ ttsReadAloud: !settings.ttsReadAloud }))}
            >
              {settings.ttsReadAloud ? '开' : '关'}
            </Button>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="自己的话也念一遍"
            hint="自己发的消息也念出来，配合语音核对发音很顺手；代价是自己那句和紧接着的译文会连读成一句话。默认关"
          >
            <Button
              variant={settings.ttsReadOwn ? 'secondary' : 'outline'}
              size="sm"
              disabled={!settings.ttsReadAloud}
              onClick={() => void save.wrap(update({ ttsReadOwn: !settings.ttsReadOwn }))}
            >
              {settings.ttsReadOwn ? '念' : '不念'}
            </Button>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row stacked label="不念谁" note={muteLineOf(channels)}>
            <Button
              variant="outline"
              size="sm"
              disabled={onOpenMuteList === undefined}
              onClick={onOpenMuteList}
            >
              改名单
            </Button>
          </Row>
        </Group>

        <Group label="对局播报">
          <Row
            label="对局播报"
            hint="智慧符、肉山复活窗口、堆野与拉野窗口，用这里选定的嗓子念；关着时下面四条连状态机都不进 —— 不是「播报但静音」"
          >
            <Button
              variant={announce ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => void save.wrap(update({ announceTotal: !announce }))}
            >
              {announce ? '开' : '关'}
            </Button>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          {ANNOUNCE_ROWS.map((item) => {
            const on = settings.announceTriggers?.[item.id] !== false
            return (
              <Row key={item.id} label={item.label} hint={item.hint}>
                <Button
                  variant={on ? 'secondary' : 'outline'}
                  size="sm"
                  disabled={!announce}
                  onClick={() =>
                    void save.wrap(
                      update({
                        announceTriggers: { ...settings.announceTriggers, [item.id]: !on }
                      })
                    )
                  }
                >
                  {on ? '开' : '关'}
                </Button>
                {!announce ? (
                  <span className="text-xs text-muted-foreground">总闸关着不生效</span>
                ) : null}
                <SaveFlash flash={save.flash} error={save.error} />
              </Row>
            )
          })}
        </Group>

        <Group label="嗓子">
          <Row
            label="合成引擎"
            htmlFor="v2-tts-engine"
            hint="联网最自然；本地离线不依赖网络；GPT-SoVITS 可克隆音色；系统嗓子仅兜底"
          >
            <select
              id="v2-tts-engine"
              value={engine}
              onChange={(e) => void save.wrap(update({ ttsEngine: e.target.value as TtsEngine }))}
              className={selectClass}
            >
              <option value="edge">联网 · 神经语音</option>
              <option value="offline">本地 · 离线模型</option>
              <option value="sovits">本地 · GPT-SoVITS</option>
              <option value="system">兜底 · 系统嗓子</option>
            </select>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="音色"
            htmlFor="v2-tts-voice"
            hint={
              engine === 'sovits'
                ? '音色由参考音频决定：一个音色包＝参考音频＋它自己的微调权重；换嗓在「音色包…」里，朗读和声出共用一个'
                : engine === 'system'
                  ? '系统嗓子由操作系统决定，没有选项'
                  : '挑一个喜欢的嗓子，点右边的试听当场验证'
            }
          >
            {engine === 'sovits' ? (
              <VoicePackDisplay
                current={currentPack}
                error={voicePacks.error}
                onOpenVoicePacks={onOpenVoicePacks}
              />
            ) : (
              <select
                id="v2-tts-voice"
                value={
                  engine === 'offline'
                    ? settings.ttsOfflineVoice
                    : settings.ttsVoice || DEFAULT_EDGE_VOICE
                }
                disabled={engine === 'system'}
                onChange={(e) => {
                  if (engine === 'offline')
                    void save.wrap(update({ ttsOfflineVoice: e.target.value as OfflineVoiceId }))
                  else void save.wrap(update({ ttsVoice: e.target.value }))
                }}
                className={`${selectClass} disabled:opacity-50`}
              >
                {engine === 'offline' ? (
                  OFFLINE_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} · {v.note}
                    </option>
                  ))
                ) : engine === 'system' ? (
                  <option value="system">系统嗓子</option>
                ) : (
                  EDGE_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))
                )}
              </select>
            )}
          </Row>
          <Row
            label="语速"
            stacked
            hint={
              engine === 'offline'
                ? '本地模型 1.0 正常，0.8 更慢（实测 0.8 以下会变得拖沓）'
                : '1.0 正常'
            }
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.7}
                max={1.6}
                step={0.05}
                value={settings.ttsRate}
                disabled={engine === 'system'}
                onChange={(e) => void update({ ttsRate: Number(e.target.value) })}
                className="h-1 w-48 accent-amber-500"
              />
              <span className="w-10 text-right font-mono text-[13px] tabular-nums">
                {settings.ttsRate.toFixed(2)}
              </span>
            </div>
          </Row>
          <Row
            label="音高"
            stacked
            hint={
              engine === 'edge'
                ? '1.00 原声，1.10 更尖，0.90 更沉'
                : '音高只对联网嗓子可用：本地模型音高固定，系统嗓子由系统控制'
            }
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.7}
                max={1.3}
                step={0.05}
                value={settings.ttsPitch}
                disabled={engine !== 'edge'}
                onChange={(e) => void update({ ttsPitch: Number(e.target.value) })}
                className="h-1 w-48 accent-amber-500"
              />
              <span className="w-10 text-right font-mono text-[13px] tabular-nums">
                {settings.ttsPitch.toFixed(2)}
              </span>
            </div>
          </Row>
          <Row
            label="试听"
            hint={`念一句「${PREVIEW_LINE}」当场验证当前引擎、嗓子、语速的组合效果`}
          >
            <Button variant="outline" size="sm" disabled={preview.busy} onClick={runPreview}>
              {preview.busy ? '合成中…' : '试听一句'}
            </Button>
            {preview.result ? (
              preview.result.ok ? (
                <StatusPill tone="ready">播放成功</StatusPill>
              ) : (
                <StatusPill tone="bad">{preview.result.error ?? '合成失败'}</StatusPill>
              )
            ) : null}
          </Row>
          <Row
            label="离线模型"
            stacked
            hint={
              offlineView.state === 'downloading'
                ? `${offlineView.text} · 已下 ${formatMegabytes(offline?.bytes ?? 0)}（关掉应用会从断点接着下）`
                : `${offlineView.text}${offlineView.state === 'failed' ? '；已经下好的部分留着，不用重头来' : ''}`
            }
          >
            <StatusPill tone={offlineTone}>
              {offline === null
                ? '读取中…'
                : offlineView.state === 'ready'
                  ? '就绪'
                  : offlineView.state === 'failed'
                    ? '失败'
                    : offlineView.state === 'downloading'
                      ? '下载中'
                      : '未下载'}
            </StatusPill>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(offline?.downloading)}
              onClick={() => void window.api.ttsOfflineDownload().then(setOffline)}
            >
              {offline?.downloading
                ? '下载中…'
                : offline?.ready
                  ? '重新下载模型'
                  : '下载模型（130 MB）'}
            </Button>
          </Row>
          <Row
            label="刷屏积压"
            hint="聊天刷屏时只念最新一条，跳过积压的旧消息：省显卡，游戏掉帧更少。默认只念最新"
          >
            <Button
              variant={settings.ttsDropBacklog ? 'secondary' : 'outline'}
              size="sm"
              disabled={!settings.ttsReadAloud}
              onClick={() => void save.wrap(update({ ttsDropBacklog: !settings.ttsDropBacklog }))}
            >
              {settings.ttsDropBacklog ? '只念最新' : '全念'}
            </Button>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="分句字数"
            htmlFor="v2-seg-chars"
            hint="长句切段上限（字）：朗读前按标点切成不超过这个长度的小段，第一段先出声。10–60，默认 30"
          >
            <Input
              id="v2-seg-chars"
              type="number"
              min={10}
              max={60}
              disabled={!settings.ttsReadAloud}
              className="w-20"
              value={settings.ttsSpeakSegmentChars ?? 30}
              onBlur={(e) => {
                const next = Math.min(60, Math.max(10, Math.round(Number(e.target.value)) || 30))
                void save.wrap(update({ ttsSpeakSegmentChars: next }))
              }}
            />
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
        </Group>

        <Group label="说法模板">
          <Row
            label="带说话人"
            htmlFor="v2-speak-prefix"
            hint="念的时候要不要带上说话人；模板里的 {who} {body} 是唯一变量，关掉就只念正文，听不出是谁在说"
          >
            <select
              id="v2-speak-prefix"
              value={settings.ttsSpeakPrefix}
              disabled={!settings.ttsReadAloud}
              onChange={(e) =>
                void save.wrap(update({ ttsSpeakPrefix: e.target.value as SpeakPrefix }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="front">句首「玩家9说，…」</option>
              <option value="back">句尾「…，玩家9表示」</option>
              <option value="off">不念</option>
            </select>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="句首模板"
            htmlFor="v2-speak-front"
            stacked
            hint="{who}=说话人，{body}=内容。标点措辞随便改，但必须保留 {body}，否则回默认"
          >
            <Input
              id="v2-speak-front"
              className="w-72"
              disabled={!settings.ttsReadAloud || settings.ttsSpeakPrefix !== 'front'}
              value={settings.ttsSpeakFrontTpl}
              placeholder="{who}说，{body}"
              onBlur={(e) => {
                const text = e.target.value.trim()
                void save.wrap(update({ ttsSpeakFrontTpl: text || '{who}说，{body}' }))
              }}
            />
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="句尾模板"
            htmlFor="v2-speak-back"
            stacked
            hint="留空就不加后缀；填了必须保留 {body}，否则回默认"
          >
            <Input
              id="v2-speak-back"
              className="w-72"
              disabled={!settings.ttsReadAloud || settings.ttsSpeakPrefix !== 'back'}
              value={settings.ttsSpeakBackTpl}
              placeholder="{body}，{who}表示"
              onBlur={(e) => {
                const text = e.target.value.trim()
                void save.wrap(update({ ttsSpeakBackTpl: text || '{body}，{who}表示' }))
              }}
            />
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
        </Group>
      </Panel>
    </>
  )
}
