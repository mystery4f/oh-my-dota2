import { useEffect, useState } from 'react'
import { SOVITS_SEED_REF_DIR, type SovitsRefEntry, type SovitsStatus } from '@shared/ipc'
import { formatMegabytes } from '@shared/first-run'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CollapsibleGroup, Group, Panel, Row, StatusPill } from '../components/primitives'
import { errorMessage as asMessage } from '@shared/errors'
import { selectClass } from '../components/select-class'
import { useSettings } from '../use-settings'
import { useVoicePacks } from '../use-voice-packs'

/**
 * 音色包：一个包＝参考音频＋它自己的微调权重；选了哪个，朗读和声出都用它。
 *
 * 四块顺序是原型定的，也是「先补缺、再挑、再调、最后看服务」的顺序：
 * 要下的东西 → 已经装好的 → 参考音频 → 引擎与服务。
 *
 * 数据只有两个来源：清单与下载进度来自 `useVoicePacks`（唯一取数入口，2 秒轮询），
 * 服务与参考库来自 `sovitsStatus()` / `sovitsRefs()`（这一页自己轮询服务）。
 */
export function PacksPage(): React.ReactElement {
  const { settings, update } = useSettings()
  // 这一页永远开着，所以取数一直开着：下载进度要接着报。
  const packs = useVoicePacks(true)
  const [status, setStatus] = useState<SovitsStatus | null>(null)
  const [refs, setRefs] = useState<SovitsRefEntry[]>([])
  const [refError, setRefError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const pullStatus = (): void => {
      void window.api.sovitsStatus().then((next) => {
        if (alive) setStatus(next)
      })
    }
    const pullRefs = (): void => {
      void window.api.sovitsRefs().then((list) => {
        if (alive) setRefs(list)
      })
    }
    pullStatus()
    pullRefs()
    const timer = window.setInterval(pullStatus, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  /** 还没装、或者装了但清单换了版：这两种都要在这一块里给出一个按钮。 */
  const todo = (packs.packs ?? []).filter((pack) => !pack.installed || pack.upgradable)
  const ready = (packs.packs ?? []).filter((pack) => pack.installed)
  const seedPresent = refs.some((ref) => ref.audio.startsWith(`${SOVITS_SEED_REF_DIR}/`))
  const activeRef = refs.find((ref) => ref.audioPath === settings?.ttsSovitsRefAudio)

  return (
    <Panel>
      <Group
        label="要下的东西"
        action={<span className="text-[11px] text-muted-foreground">远端清单还没接，这一行只报本地状态</span>}
      >
        {packs.packs === null ? (
          <Row label="清单">
            <StatusPill tone="idle">读取中…</StatusPill>
          </Row>
        ) : todo.length === 0 ? (
          <Row label="清单" hint="清单里的包都已经装好，换版时这里会自动多出一行">
            <StatusPill tone="ready">都装齐了。</StatusPill>
          </Row>
        ) : (
          todo.map((pack) => (
            <Row
              key={pack.id}
              stacked
              label={pack.name}
              hint={`${pack.note ? `${pack.note} · ` : ''}v${pack.version} · 还需 ${formatMegabytes(pack.bytes - pack.haveBytes)}`}
            >
              {pack.error ? <span className="text-xs text-destructive">{pack.error}</span> : null}
              {pack.downloading ? (
                <StatusPill tone="warn">{`下载中 ${Math.round(pack.progress * 100)}%`}</StatusPill>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={packs.busy}
                  onClick={() => packs.install(pack.id)}
                >
                  {pack.error ? '重试' : pack.haveBytes > 0 ? '接着下' : '下载'}
                </Button>
              )}
            </Row>
          ))
        )}
        {packs.error ? (
          <Row label="清单请求失败">
            <StatusPill tone="bad">{packs.error}</StatusPill>
          </Row>
        ) : null}
      </Group>

      <Group
        label="已经装好的"
        action={<span className="text-[11px] text-muted-foreground">选了就用它</span>}
      >
        {ready.length === 0 ? (
          <Row label="已装" hint="一个都还没装，先在上面那块里下载一个">
            <StatusPill tone="idle">空</StatusPill>
          </Row>
        ) : (
          ready.map((pack) => (
            <Row
              key={pack.id}
              stacked
              label={pack.name}
              hint={`${pack.upgradable && pack.installedVersion ? `v${pack.installedVersion} → v${pack.version}` : `v${pack.version}`} · ${formatMegabytes(pack.bytes)}${pack.active ? ` · 现在生效：${pack.name}` : ''}`}
            >
              {pack.downloading ? (
                <StatusPill tone="warn">{`下载中 ${Math.round(pack.progress * 100)}%`}</StatusPill>
              ) : null}
              {pack.upgradable && !pack.downloading ? (
                <Button size="sm" variant="outline" onClick={() => packs.install(pack.id)}>
                  升级
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={pack.active ? 'ghost' : 'secondary'}
                disabled={pack.active || packs.busy || pack.downloading}
                onClick={() => packs.select(pack.id)}
              >
                {pack.active ? '正在用' : '使用'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pack.active || pack.downloading}
                title={pack.active ? '先在别处切到另一个音色再删' : undefined}
                onClick={() => packs.remove(pack.id)}
              >
                删除
              </Button>
              {pack.error ? <span className="text-xs text-destructive">{pack.error}</span> : null}
            </Row>
          ))
        )}
      </Group>

      <Group
        label="参考音频"
        action={<span className="text-[11px] text-muted-foreground">选中即换，下一句生效</span>}
      >
        <Row
          label="参考音频"
          htmlFor="v2-pack-ref"
          hint={
            refs.length === 0
              ? '库是空的：先装一个音色包，或用下面的保底参考现合成一条'
              : '这一行的选择和上面「使用」写同一个设置键，换了两边一起变'
          }
        >
          <select
            id="v2-pack-ref"
            value={activeRef?.audio ?? ''}
            disabled={refs.length === 0}
            onChange={(e) => {
              const picked = refs.find((ref) => ref.audio === e.target.value)
              if (!picked) return
              setRefError(null)
              void update({
                ttsSovitsRefAudio: picked.audioPath,
                ttsSovitsPromptText: picked.promptText,
                ttsSovitsPromptLang: picked.promptLang
              })
              void window.api.sovitsSelectRef(picked).catch((err: unknown) => {
                setRefError(asMessage(err))
              })
            }}
            className={`${selectClass} max-w-64`}
          >
            <option value="">{refs.length === 0 ? '库是空的' : '从参考音频库选择…'}</option>
            {refs.map((ref) => (
              <option key={ref.audio} value={ref.audio}>
                {ref.name}
                {ref.gptWeightsPath ? ' · 微调' : ''}
              </option>
            ))}
          </select>
          {refError ? <StatusPill tone="bad">{refError}</StatusPill> : null}
        </Row>
        {!seedPresent ? (
          <Row label="保底参考" hint="用免费的 Edge 嗓子现合成一条晓晓参考写进库里，不下载模型">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void window.api.sovitsSeed().then(() => {
                  void window.api.sovitsRefs().then(setRefs)
                  packs.reload()
                })
              }
            >
              现合成一条
            </Button>
          </Row>
        ) : null}
        <Row label="逐字转写" htmlFor="v2-pack-prompt" hint="参考音频说了什么，一字不差；对不上音质会明显劣化">
          <input
            id="v2-pack-prompt"
            className={`${selectClass} w-80`}
            value={settings?.ttsSovitsPromptText ?? ''}
            onChange={(e) => void update({ ttsSovitsPromptText: e.target.value })}
            placeholder="参考音频的逐字转写"
          />
          <select
            value={settings?.ttsSovitsPromptLang ?? 'zh'}
            onChange={(e) => void update({ ttsSovitsPromptLang: e.target.value as 'zh' | 'en' })}
            className={selectClass}
            title="参考音频的语言：转写是什么语言就选什么"
          >
            <option value="zh">中文</option>
            <option value="en">英文</option>
          </select>
        </Row>
        <Row label="野路径" stacked hint="服务端磁盘上的绝对路径；一般从上面库里选，这里留给临时试音">
          <Input
            className="w-full max-w-96"
            value={settings?.ttsSovitsRefAudio ?? ''}
            onChange={(e) => void update({ ttsSovitsRefAudio: e.target.value })}
            placeholder="服务端磁盘上的绝对路径"
          />
        </Row>
      </Group>

      <Group
        label="引擎与服务"
        action={<span className="text-[11px] text-muted-foreground">缺哪一环说哪一环</span>}
      >
        <Row label="引擎包目录" hint="填了应用启动时自动拉起 api_v2（加载约 40 秒），退出时收掉">
          <Input
            className="w-72"
            value={settings?.ttsSovitsHome ?? ''}
            onChange={(e) => void update({ ttsSovitsHome: e.target.value })}
            placeholder={status?.installHome || '留空＝用数据目录的 gpt-sovits 自装位'}
          />
        </Row>
        <Row label="服务地址" hint="整合包 runtime 起的本地端口">
          <Input
            className="w-56 font-mono"
            value={settings?.ttsSovitsUrl ?? ''}
            onChange={(e) => void update({ ttsSovitsUrl: e.target.value })}
            placeholder="http://127.0.0.1:9880"
          />
        </Row>
        <Row
          label="服务"
          hint={
            status
              ? `引擎包：${status.installed ? '已安装' : '未安装'} · 目录 ${status.home || '（空）'}`
              : undefined
          }
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
                  disabled={
                    status.install.phase === 'downloading' || status.install.phase === 'extracting'
                  }
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
          <CollapsibleGroup id="packs.logs" label="日志" action={<span className="text-xs text-muted-foreground">最近 {status.logs.length} 行</span>}>
            <pre className="max-h-64 w-full overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-4 text-muted-foreground">
              {status.logs.join('\n')}
            </pre>
          </CollapsibleGroup>
        ) : null}
      </Group>
    </Panel>
  )
}