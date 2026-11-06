import { useEffect, useState } from 'react'
import {
  SOVITS_SEED_REF_DIR,
  type SovitsRefEntry,
  type SovitsStatus,
  type SovitsVoicePack
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Group, Row, StatusPill } from '../components/primitives'
import { useSettings } from '../use-settings'

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-sm'
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`

/**
 * 音色包与 GV 服务：参考音频决定音色，权重随包子自动切换。
 * 折叠组里才挂载，所以这里的 3 秒轮询只在真要看时才跑。
 */
export function SovitsPanel(): React.ReactElement {
  const { settings, update } = useSettings()
  const [status, setStatus] = useState<SovitsStatus | null>(null)
  const [packs, setPacks] = useState<SovitsVoicePack[]>([])
  const [refs, setRefs] = useState<SovitsRefEntry[]>([])
  const [pick, setPick] = useState<string>('')
  const [packErr, setPackErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.api.sovitsStatus().then((s) => alive && setStatus(s))
    }
    refresh()
    const timer = setInterval(refresh, 3000)
    void window.api.sovitsVoicepacks().then((list) => alive && setPacks(list))
    void window.api.sovitsRefs().then((list) => alive && setRefs(list))
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (settings === null) return <Row label="配置" hint="读取中…" />

  const selected = packs.find((pack) => pack.id === pick) ?? packs[0]
  const seedPresent = refs.some((ref) => ref.audio.startsWith(`${SOVITS_SEED_REF_DIR}/`))

  return (
    <>
      <Group label="音色包">
        {selected ? (
          <>
            <Row label="音色包" htmlFor="v2-pack" hint={selected.note}>
              <select
                id="v2-pack"
                value={selected.id}
                onChange={(e) => {
                  setPick(e.target.value)
                  setPackErr(null)
                }}
                className={`${selectClass} max-w-60`}
              >
                {packs.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.name} ·{' '}
                    {pack.downloading
                      ? `下载中 ${Math.round(pack.progress * 100)}%`
                      : pack.upgradable
                        ? '可升级'
                        : pack.installed
                          ? '已就绪'
                          : '未下载'}
                  </option>
                ))}
              </select>
              {/* 状态在 select 的选项文字里已经说了一次；这里只补「会变」的那两个。 */}
              {selected.downloading ? (
                <StatusPill tone="warn">↓ {Math.round(selected.progress * 100)}%</StatusPill>
              ) : selected.upgradable ? (
                <StatusPill tone="warn">有新版</StatusPill>
              ) : null}
              <span className="text-xs tabular-nums text-muted-foreground">
                {selected.upgradable && selected.installedVersion
                  ? `v${selected.installedVersion} → v${selected.version}`
                  : `v${selected.version}`}
                {' · '}
                {selected.installed ? mb(selected.bytes) : `还需 ${mb(selected.bytes - selected.haveBytes)}`}
              </span>
              {selected.active ? <StatusPill tone="ready">使用中</StatusPill> : null}
              {selected.defaultPack ? <StatusPill tone="idle">默认</StatusPill> : null}
            </Row>
            <Row label="操作" hint={selected.error ?? packErr ?? undefined}>
              {!selected.installed && !selected.downloading ? (
                <Button size="sm" variant="outline" onClick={() => void window.api.sovitsVoicepackInstall(selected.id).then(setPacks)}>
                  下载
                </Button>
              ) : null}
              {selected.upgradable && !selected.downloading ? (
                <Button size="sm" variant="outline" onClick={() => void window.api.sovitsVoicepackInstall(selected.id).then(setPacks)}>
                  升级
                </Button>
              ) : null}
              {selected.installed && !selected.upgradable ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selected.downloading}
                    onClick={() => void window.api.sovitsVoicepackInstall(selected.id).then(setPacks)}
                  >
                    重新下载
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selected.active}
                    title={selected.active ? '先在参考音频里切到别的音色' : undefined}
                    onClick={() => {
                      setPackErr(null)
                      void window.api
                        .sovitsVoicepackDelete(selected.id)
                        .then(setPacks)
                        .catch((err: unknown) => setPackErr(err instanceof Error ? err.message : String(err)))
                    }}
                  >
                    删除
                  </Button>
                </>
              ) : null}
            </Row>
          </>
        ) : (
          <Row label="音色包" hint="清单还没拿到：拉不到远端就用内置清单，稍等或重开这一页">
            <StatusPill tone="idle">读取中…</StatusPill>
          </Row>
        )}
      </Group>

      <Group label="参考音频">
        <Row label="从库里选" htmlFor="v2-ref" hint="选中即整套换参考，下一句朗读就生效">
          <select
            id="v2-ref"
            value={refs.find((ref) => ref.audioPath === settings.ttsSovitsRefAudio)?.audio ?? ''}
            onChange={(e) => {
              const picked = refs.find((ref) => ref.audio === e.target.value)
              if (!picked) return
              // 激活是主进程的事：写设置 → 切权重 → 预热一气呵成。
              void update({
                ttsSovitsRefAudio: picked.audioPath,
                ttsSovitsPromptText: picked.promptText,
                ttsSovitsPromptLang: picked.promptLang
              })
              void window.api.sovitsSelectRef(picked)
            }}
            disabled={refs.length === 0}
            className={`${selectClass} max-w-60`}
          >
            <option value="">{refs.length === 0 ? '库是空的' : '从参考音频库选择…'}</option>
            {refs.map((ref) => (
              <option key={ref.audio} value={ref.audio}>
                {ref.name}
                {ref.gptWeightsPath ? ' · 微调' : ''}
              </option>
            ))}
          </select>
          {!seedPresent ? (
            <Button
              size="sm"
              variant="outline"
              title="用免费的 Edge 嗓子现合成一条晓晓参考写进库里，不下载模型；已有音色包也能补"
              onClick={() =>
                void window.api.sovitsSeed().then(() => {
                  void window.api.sovitsRefs().then(setRefs)
                  void window.api.sovitsVoicepacks().then(setPacks)
                })
              }
            >
              现合成一条保底参考（免费）
            </Button>
          ) : null}
        </Row>
      </Group>

      <Group label="服务">
        <Row label="引擎包目录" hint="填了应用启动时自动拉起 api_v2（加载约 40 秒），退出时收掉">
          <Input
            className="w-72"
            value={settings.ttsSovitsHome}
            onChange={(e) => update({ ttsSovitsHome: e.target.value })}
            onBlur={() => update({ ttsSovitsHome: settings.ttsSovitsHome.trim() })}
            placeholder={status?.installHome || '留空＝用数据目录的 gpt-sovits 自装位'}
          />
        </Row>
        <Row label="服务地址" hint="整合包 runtime 起的本地端口">
          <Input
            className="w-56 font-mono"
            value={settings.ttsSovitsUrl}
            onChange={(e) => update({ ttsSovitsUrl: e.target.value })}
            onBlur={() => update({ ttsSovitsUrl: settings.ttsSovitsUrl.trim() || 'http://127.0.0.1:9880' })}
            placeholder="http://127.0.0.1:9880"
          />
        </Row>
        <Row label="参考音频" stacked hint="决定音色的那段声音；一般从上面库里选，这里留给临时野路径">
          <Input
            className="w-full max-w-96"
            value={settings.ttsSovitsRefAudio}
            onChange={(e) => update({ ttsSovitsRefAudio: e.target.value })}
            placeholder="服务端磁盘上的绝对路径"
          />
        </Row>
        <Row label="逐字转写" htmlFor="v2-promptText" hint="参考音频说了什么，一字不差；对不上音质会明显劣化">
          <input
            id="v2-promptText"
            className="h-8 w-72 rounded-md border border-input bg-background px-2 text-sm"
            value={settings.ttsSovitsPromptText}
            onChange={(e) => update({ ttsSovitsPromptText: e.target.value })}
            placeholder="参考音频的逐字转写"
          />
          <select
            value={settings.ttsSovitsPromptLang}
            onChange={(e) => void update({ ttsSovitsPromptLang: e.target.value as 'zh' | 'en' })}
            className={selectClass}
            title="参考音频的语言：转写是什么语言就选什么"
          >
            <option value="zh">中文</option>
            <option value="en">英文</option>
          </select>
        </Row>
        <Row
          label="运行状态"
          hint={status ? `引擎包：${status.installed ? '已安装' : '未安装'} · 目录 ${status.home || '（空）'}` : undefined}
        >
          {status === null ? (
            <StatusPill tone="idle">读取中…</StatusPill>
          ) : (
            <>
              <StatusPill
                tone={
                  status.server.phase === 'ready' || status.server.phase === 'external'
                    ? 'ready'
                    : status.server.phase === 'starting'
                      ? 'warn'
                      : 'bad'
                }
              >
                {status.server.phase === 'ready'
                  ? '服务运行中'
                  : status.server.phase === 'external'
                    ? '外部实例在跑'
                    : status.server.phase === 'starting'
                      ? '正在拉起'
                      : '服务未启动'}
              </StatusPill>
              <span className="text-xs text-muted-foreground">{status.server.detail}</span>
              {status.server.pid !== null ? (
                <span className="text-xs tabular-nums text-muted-foreground">PID {status.server.pid}</span>
              ) : null}
              {!status.installed ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={status.install.phase === 'downloading' || status.install.phase === 'extracting'}
                  onClick={() => void window.api.sovitsInstall().then(setStatus)}
                >
                  {status.install.phase === 'downloading'
                    ? `下载中 ${Math.round(status.install.progress * 100)}%`
                    : status.install.phase === 'extracting'
                      ? '解压中…'
                      : status.archivePresent
                        ? '解压已下载的压缩包'
                        : '下载引擎包（8.2 GB）'}
                </Button>
              ) : null}
            </>
          )}
        </Row>
        {status?.install.error ? (
          <Row label="安装失败" hint={status.installRoot}>
            <StatusPill tone="bad">{status.install.error}</StatusPill>
          </Row>
        ) : null}
        {status && status.logs.length > 0 ? (
          <Row label="日志" stacked hint={`最近 ${status.logs.length} 行`}>
            <pre className="max-h-40 w-full overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-4 text-muted-foreground">
              {status.logs.join('\n')}
            </pre>
          </Row>
        ) : null}
      </Group>
    </>
  )
}
