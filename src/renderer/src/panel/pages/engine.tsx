import { useState } from 'react'
import {
  PROVIDER_PRESETS,
  type ProviderId,
  type TestResult,
  type TranslationCacheCounts,
  type TranslateDirection
} from '@shared/ipc'
import { reasoningForProvider } from '@shared/provider-reasoning'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, SaveFlash, StatusPill } from '../components/primitives'
import { useSaveFlash, useSettings } from '../use-settings'

/**
 * 翻译引擎页：服务 / 输出 / 推理 / 缓存 四组 + 底部试验台。
 * 与旧版的行为差异只有一条：没有「保存」按钮——每个控件改完即存。
 * applyPreset 的注释级坑（authStyle 跟着预设盖、key 按家取回）原样搬过来。
 */

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: TestResult }

export function EnginePage(): React.ReactElement {
  const { settings, update, loadError } = useSettings()
  const test = useTestState()
  const cache = useCacheClear()
  const save = useSaveFlash()

  if (settings === null) {
    return (
      <Panel>
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {loadError ? `读取配置失败：${loadError}` : '读取设置中…'}
        </div>
      </Panel>
    )
  }

  const preset = PROVIDER_PRESETS.find((p) => p.id === settings.provider.id)

  const applyPreset = (id: ProviderId): void => {
    const next = PROVIDER_PRESETS.find((p) => p.id === id)
    if (!next) return
    // authStyle 必须跟着预设一起盖：换供应商会残留上一家的鉴权头（MiMo 的 api-key），GLM 就报 401。
    // key / 推理开关按家存档取回（providerKeys / providerReasoning），换家不丢、没记过给默认。
    void save.wrap(
      update({
        provider: {
          id,
          baseUrl: next.baseUrl,
          model: next.model,
          authStyle: next.authStyle,
          apiKey: settings.providerKeys?.[id] ?? '',
          reasoning: reasoningForProvider(id, next, settings.providerReasoning)
        }
      })
    )
  }

  return (
    <>
      <Panel>
        <Group label="服务">
          <Row label="预设" htmlFor="v2-preset">
            <Select
              id="v2-preset"
              value={settings.provider.id}
              onChange={(e) => applyPreset(e.target.value as ProviderId)}
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="接口地址"
            htmlFor="v2-baseUrl"
            hint="任意 OpenAI 兼容接口；预设选好后一般不用改"
          >
            <Input
              id="v2-baseUrl"
              className="w-72"
              value={settings.provider.baseUrl}
              onChange={(e) => void update({ provider: { ...settings.provider, baseUrl: e.target.value } })}
              placeholder="https://api.deepseek.com"
            />
          </Row>
          <Row
            label={`API Key${preset && !preset.needsKey ? '（可不填）' : ''}`}
            htmlFor="v2-apiKey"
            hint="一把钥匙两处记：当前生效 + 按家存档，切预设不丢"
          >
            <Input
              id="v2-apiKey"
              type="password"
              className="w-72"
              value={settings.provider.apiKey}
              onChange={(e) =>
                void save.wrap(
                  update({
                    provider: { ...settings.provider, apiKey: e.target.value },
                    providerKeys: { ...settings.providerKeys, [settings.provider.id]: e.target.value }
                  })
                )
              }
              placeholder="sk-…"
            />
          </Row>
          <Row label="模型" htmlFor="v2-model">
            <Input
              id="v2-model"
              className="w-72"
              value={settings.provider.model}
              onChange={(e) => void update({ provider: { ...settings.provider, model: e.target.value } })}
              placeholder="deepseek-chat"
            />
          </Row>
          <Row label="代理" htmlFor="v2-proxy" hint="留空直连">
            <Input
              id="v2-proxy"
              className="w-72"
              value={settings.proxyUrl}
              onChange={(e) => void update({ proxyUrl: e.target.value })}
              placeholder="http://127.0.0.1:7890"
            />
          </Row>
          <Row
            label="推理（先思考再翻）"
            hint="默认关：翻译是短句任务，思考只加延迟（MiMo 实测 1.4s → 7.4s）"
          >
            <Button
              variant={settings.provider.reasoning ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => {
                const reasoning = !settings.provider.reasoning
                void save.wrap(
                  update({
                    provider: { ...settings.provider, reasoning },
                    providerReasoning: { ...settings.providerReasoning, [settings.provider.id]: reasoning }
                  })
                )
              }}
            >
              {settings.provider.reasoning ? '开' : '关'}
            </Button>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row label="连通性" hint={test.done ? test.text : '翻译一句试试，立刻知道这家服务通不通'}>
            <Button variant="outline" size="sm" onClick={() => void test.run(settings.provider)} disabled={test.running}>
              {test.running ? '测试中…' : '测试连接'}
            </Button>
            {test.done ? <StatusPill tone={test.result.ok ? 'ready' : 'bad'}>{test.text}</StatusPill> : null}
          </Row>
        </Group>

        <Group label="输出">
          <Row label="浮层译文语言" htmlFor="v2-targetLang">
            <Select
              id="v2-targetLang"
              value={settings.targetLang}
              onChange={(e) => void save.wrap(update({ targetLang: e.target.value }))}
            >
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
            </Select>
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
          <Row
            label="译文词数上限"
            htmlFor="v2-maxWords"
            hint="中文→英文译文最多几个词（4-32，默认 16）；改动会按新上限重建翻译会话"
          >
            <Input
              id="v2-maxWords"
              type="number"
              min={4}
              max={32}
              className="w-20"
              value={settings.translationMaxWords ?? 16}
              onChange={(e) => void save.wrap(update({ translationMaxWords: Number(e.target.value) }))}
            />
            <SaveFlash flash={save.flash} error={save.error} />
          </Row>
        </Group>

        <Group label="缓存">
          <Row
            label="翻译缓存"
            hint={cache.flash || '按模型隔离：翻译记忆 + 对话历史，清了别的模型不受影响'}
          >
            {cache.confirm ? null : (
              <Button variant="outline" size="sm" onClick={() => void cache.inspect()} disabled={cache.busy}>
                {cache.busy ? '读取中…' : '清空缓存'}
              </Button>
            )}
            {cache.confirm ? (
              <ConfirmClear
                counts={cache.confirm}
                onCancel={cache.cancel}
                onConfirm={() => void cache.clear()}
              />
            ) : null}
          </Row>
        </Group>
      </Panel>

      <TrialBench />
    </>
  )
}

/** 测试连接的小状态机：idle / running / done 三态，结果带一句人话。 */
function useTestState(): {
  running: boolean
  done: boolean
  result: TestResult
  text: string
  run: (provider: AppSettingsProvider) => Promise<void>
} {
  const [state, setState] = useState<TestState>({ status: 'idle' })
  const run = async (provider: AppSettingsProvider): Promise<void> => {
    setState({ status: 'running' })
    try {
      setState({ status: 'done', result: await window.api.testProvider(provider) })
    } catch (e) {
      setState({
        status: 'done',
        result: { ok: false, message: e instanceof Error ? e.message : String(e) }
      })
    }
  }
  const done = state.status === 'done'
  const result = done ? (state as { status: 'done'; result: TestResult }).result : { ok: false, message: '' }
  const text = result.ok ? `正常 ${result.latencyMs ?? '?'} ms` : `失败：${result.message.slice(0, 60)}`
  return { running: state.status === 'running', done, result, text, run }
}

type AppSettingsProvider = AppSettings2['provider']
type AppSettings2 = import('@shared/ipc').AppSettings

/** 清缓存两步走：inspect 拿真实数字，页面内自绘确认框（原生 confirm 会毁 IME 上下文）。 */
function useCacheClear(): {
  busy: boolean
  flash: string
  confirm: TranslationCacheCounts | null
  inspect: () => Promise<void>
  clear: () => Promise<void>
  cancel: () => void
} {
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')
  const [confirm, setConfirm] = useState<TranslationCacheCounts | null>(null)

  const inspect = async (): Promise<void> => {
    setBusy(true)
    try {
      const counts = await window.api.translationCacheInspect()
      setConfirm(counts)
    } catch {
      setFlash('读取缓存失败')
    }
    setBusy(false)
  }

  const clear = async (): Promise<void> => {
    setConfirm(null)
    setBusy(true)
    try {
      const done = await window.api.translationCacheClear()
      setFlash(`已清空（${done.pairs} 对记忆、${done.conversations} 条会话）`)
    } catch (e) {
      setFlash(`清空失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setBusy(false)
  }

  return { busy, flash, confirm, inspect, clear, cancel: () => setConfirm(null) }
}

function ConfirmClear({
  counts,
  onCancel,
  onConfirm
}: {
  counts: TranslationCacheCounts
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium">清空翻译缓存</p>
        <p className="mt-2 text-sm text-muted-foreground">
          将清空「{counts.model}」的翻译缓存：{counts.pairs} 对翻译记忆、{counts.conversations} 条会话历史。
          其它模型的缓存不受影响，此操作不能撤销。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            确定清空
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 试验台：原「翻译试用」tab，双向各一个输入框，就地看结果。 */
function TrialBench(): React.ReactElement {
  return (
    <Panel>
      <Group label="试验台">
        <TrialRow
          direction="en-zh"
          label="队友发言 → 中文"
          initial="careful mid, they smoke rosh"
        />
        <TrialRow
          direction="zh-en"
          label="我的回复 → 英文"
          initial="小心点，他们可能在打肉山"
        />
      </Group>
    </Panel>
  )
}

function TrialRow({
  direction,
  label,
  initial
}: {
  direction: TranslateDirection
  label: string
  initial: string
}): React.ReactElement {
  const [text, setText] = useState(initial)
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      setOut(await window.api.translate(text, direction))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row label={label} stacked hint="走的是和真实链路同一条翻译通道">
      <div className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="输入一句话…" />
        <Button size="sm" onClick={() => void run()} disabled={busy || !text.trim()}>
          {busy ? '翻译中…' : '翻译'}
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {out ? <p className="mt-2 rounded-md bg-secondary p-3 text-sm">{out}</p> : null}
    </Row>
  )
}
