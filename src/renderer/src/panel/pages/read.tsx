import { useEffect, useState } from 'react'
import {
  OFFLINE_VOICES,
  type OfflineStatus,
  type OfflineVoiceId,
  type VoicePreviewResult
} from '@shared/ipc'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES } from '@shared/tts-voices'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CollapsibleGroup, Group, Panel, Row, SaveFlash, StatusPill } from '../components/primitives'
import { useSaveFlash, useSettings } from '../use-settings'
import { useVoicePacks } from '../use-voice-packs'

type TtsEngine = 'system' | 'edge' | 'offline' | 'sovits'
type SpeakPrefix = 'front' | 'back' | 'off'

const PREVIEW_LINE = '小心，他们可能在打肉山，快回来'

/** 朗读页：我听别人说。引擎、嗓子、说话人念法都在这里调，试听当场验证。 */
export function ReadPage({
  onOpenVoicePacks
}: {
  /** 打开音色包弹窗：下载、删除、参考音频、GV 服务都在那里，这一行只负责选。 */
  onOpenVoicePacks?: () => void
}): React.ReactElement {
  const { settings, update, loadError } = useSettings()
  const save = useSaveFlash()
  const [offline, setOffline] = useState<OfflineStatus | null>(null)
  const [preview, setPreview] = useState<{ busy: boolean; result: VoicePreviewResult | null }>({
    busy: false,
    result: null
  })
  useEffect(() => {
    void window.api.ttsOfflineState().then(setOffline)
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
          const audio = new Audio(`data:${result.audioMime ?? 'audio/mp3'};base64,${result.audioBase64}`)
          void audio.play()
        }
      })
      .catch((e: unknown) => {
        setPreview({ busy: false, result: { ok: false, error: e instanceof Error ? e.message : String(e) } })
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

  return (
    <>
      <Panel>
        <Group label="开关">
          <Row label="朗读新消息" hint="中文原话、英文译文都会念，只念内容不念「谁说的」">
            <Button
              variant={settings.ttsReadAloud ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => void save.wrap(update({ ttsReadAloud: !settings.ttsReadAloud }))}
            >
              {settings.ttsReadAloud ? '开' : '关'}
            </Button>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
        </Group>
        <Group label="引擎与嗓子">
          <Row
            label="合成引擎"
            htmlFor="v2-tts-engine"
            hint="联网最自然；本地离线不依赖网络；GPT-SoVITS 可克隆音色；系统嗓子仅兜底"
          >
            <select
              id="v2-tts-engine"
              value={engine}
              onChange={(e) => void save.wrap(update({ ttsEngine: e.target.value as TtsEngine }))}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
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
              <>
                <span className="text-sm">{currentPack ? currentPack.name : '还没选音色包'}</span>
                {currentPack?.downloading ? (
                  <StatusPill tone="warn">↓ {Math.round(currentPack.progress * 100)}%</StatusPill>
                ) : null}
                {voicePacks.error ? <StatusPill tone="bad">{voicePacks.error}</StatusPill> : null}
                {onOpenVoicePacks ? (
                  <Button size="sm" variant="outline" onClick={onOpenVoicePacks}>
                    音色包…
                  </Button>
                ) : null}
              </>
            ) : (
              <select
                id="v2-tts-voice"
                value={engine === 'offline' ? settings.ttsOfflineVoice : settings.ttsVoice || DEFAULT_EDGE_VOICE}
                disabled={engine === 'system'}
                onChange={(e) => {
                  if (engine === 'offline')
                    void save.wrap(update({ ttsOfflineVoice: e.target.value as OfflineVoiceId }))
                  else void save.wrap(update({ ttsVoice: e.target.value }))
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
              >
                {engine === 'offline'
                  ? OFFLINE_VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} · {v.note}
                      </option>
                    ))
                  : engine === 'system'
                    ? <option value="system">系统嗓子</option>
                    : EDGE_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            )}
          </Row>
          <Row label="语速" stacked hint={engine === 'offline' ? '本地模型 1.0 正常，0.8 更慢（实测 0.8 以下会变得拖沓）' : '1.0 正常'}>
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
            hint={engine === 'edge' ? '1.00 原声，1.10 更尖，0.90 更沉' : '音高只对联网嗓子可用：本地模型音高固定，系统嗓子由系统控制'}
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
        </Group>

        <CollapsibleGroup id="read.behavior" label="念什么">
          <Row
            label="自己的话"
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
        </CollapsibleGroup>

        <CollapsibleGroup id="read.speaker" label="说话人念法">
          <Row
            label="说话人标签"
            htmlFor="v2-speak-prefix"
            hint="「某某说」念在哪头：句首先知道是谁说的，句尾先听内容，不念只听内容"
          >
            <select
              id="v2-speak-prefix"
              value={settings.ttsSpeakPrefix}
              disabled={!settings.ttsReadAloud}
              onChange={(e) => void save.wrap(update({ ttsSpeakPrefix: e.target.value as SpeakPrefix }))}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="front">句首「玩家9说，…」</option>
              <option value="back">句尾「…，玩家9表示」</option>
              <option value="off">不念</option>
            </select>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          {settings.ttsSpeakPrefix !== 'off' ? (
            <Row
              label={settings.ttsSpeakPrefix === 'front' ? '句首模板' : '句尾模板'}
              htmlFor="v2-speak-tpl"
              stacked
              hint="{who}=说话人，{body}=内容。标点措辞随便改，但必须保留 {body}，否则回默认"
            >
              <Input
                id="v2-speak-tpl"
                className="w-72"
                disabled={!settings.ttsReadAloud}
                value={
                  settings.ttsSpeakPrefix === 'front'
                    ? settings.ttsSpeakFrontTpl
                    : settings.ttsSpeakBackTpl
                }
                placeholder={settings.ttsSpeakPrefix === 'front' ? '{who}说，{body}' : '{body}，{who}表示'}
                onBlur={(e) => {
                  const text = e.target.value.trim()
                  void save.wrap(
                    settings.ttsSpeakPrefix === 'front'
                      ? update({ ttsSpeakFrontTpl: text || '{who}说，{body}' })
                      : update({ ttsSpeakBackTpl: text || '{body}，{who}表示' })
                  )
                }}
              />
            </Row>
          ) : null}
        </CollapsibleGroup>

        <CollapsibleGroup id="read.offline" label="离线模型">
          <Row
            label="离线模型状态"
            hint="模型文件在数据目录 tts-models/ 下；在线时用不到它"
          >
            {offline === null ? (
              <StatusPill tone="idle">读取中…</StatusPill>
            ) : offline.ready ? (
              <StatusPill tone="ready">已就绪 {Math.round((offline.bytes ?? 0) / 1048576)} MB</StatusPill>
            ) : offline.downloading ? (
              <StatusPill tone="warn">下载中 {Math.round((offline.progress ?? 0) * 100)}%</StatusPill>
            ) : (
              <StatusPill tone="idle">未下载</StatusPill>
            )}
            {offline !== null && offline.error !== null && offline.error !== undefined && !offline.ready ? (
              <StatusPill tone="bad">下载失败</StatusPill>
            ) : null}
          </Row>
          <Row
            label="下载"
            hint={offline?.ready ? '模型已在本地：再点一次会重新下载（文件损坏时用这个自救）' : '模型约 130 MB，下载后离线可用'}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(offline?.downloading)}
              onClick={() => void window.api.ttsOfflineDownload().then(setOffline)}
            >
              {offline?.downloading
                ? `下载中 ${Math.round((offline.progress ?? 0) * 100)}%`
                : offline?.ready
                  ? '重新下载模型'
                  : '下载模型（130 MB）'}
            </Button>
          </Row>
        </CollapsibleGroup>
      </Panel>
    </>
  )
}
