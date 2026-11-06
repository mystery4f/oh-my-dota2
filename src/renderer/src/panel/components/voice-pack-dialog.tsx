import { useEffect, useState } from 'react'
import { SOVITS_SEED_REF_DIR, type SovitsRefEntry, type SovitsStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from './modal'
import { Group, Row, StatusPill } from './primitives'
import { errorMessage as asMessage } from '@shared/errors'
import { selectClass } from './select-class'
import { useSettings } from '../use-settings'
import { useVoicePacks } from '../use-voice-packs'

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`

type Tab = 'packs' | 'refs' | 'server'

const TABS: { id: Tab; label: string }[] = [
  { id: 'packs', label: '音色包' },
  { id: 'refs', label: '参考音频' },
  { id: 'server', label: 'GV 服务' }
]

/**
 * 音色包弹窗。为什么是弹窗而不是一页：这些行的真实生命周期是「装一次、偶尔换」，
 * 贴在任何一页都会把常用行挤下去；而朗读页和声出都想换它，所以只有它俩共用一个入口。
 *
 * 清单与下载进度来自 useVoicePacks（唯一取数入口），服务与参考音频只在这里轮询。
 */
export function VoicePackDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.ReactElement {
  const { settings, update } = useSettings()
  const packs = useVoicePacks(open)
  const [tab, setTab] = useState<Tab>('packs')
  const [status, setStatus] = useState<SovitsStatus | null>(null)
  const [refs, setRefs] = useState<SovitsRefEntry[]>([])
  const [refError, setRefError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const pullStatus = (): void => {
      void window.api.sovitsStatus().then((s) => {
        if (alive) setStatus(s)
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
  }, [open])

  const seedPresent = refs.some((ref) => ref.audio.startsWith(`${SOVITS_SEED_REF_DIR}/`))
  const activeRef = refs.find((ref) => ref.audioPath === settings?.ttsSovitsRefAudio)

  return (
    <Modal
      open={open}
      title="音色包"
      hint="一个音色包＝参考音频＋它自己的微调权重；选了哪个，朗读和声出都用它"
      onClose={onClose}
    >
      <div className="sticky top-0 z-10 flex gap-1 border-b border-border/60 bg-card px-3 py-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-pressed={tab === item.id}
            className={
              tab === item.id
                ? 'rounded bg-muted px-2.5 py-1 text-xs font-medium text-foreground'
                : 'rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'packs' ? (
        <div>
          {packs.packs === null ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">读取音色包清单…</div>
          ) : packs.packs.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              清单是空的：远端拉不到时会回落到内置清单，稍等或重开这一页。
            </div>
          ) : (
            packs.packs.map((pack) => {
              const version = pack.upgradable && pack.installedVersion
                ? `v${pack.installedVersion} → v${pack.version}`
                : `v${pack.version}`
              const size = pack.installed
                ? mb(pack.bytes)
                : `还需 ${mb(pack.bytes - pack.haveBytes)}`
              return (
                <div
                  key={pack.id}
                  className="flex items-center justify-between gap-4 border-b border-border/40 px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {pack.name}
                      {pack.active ? <StatusPill tone="ready">使用中</StatusPill> : null}
                      {pack.downloading ? (
                        <StatusPill tone="warn">↓ {Math.round(pack.progress * 100)}%</StatusPill>
                      ) : null}
                      {pack.defaultPack ? (
                        <span className="text-[11px] text-muted-foreground">默认</span>
                      ) : null}
                    </div>
                    {pack.note ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{pack.note}</p>
                    ) : null}
                    <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                      {version} · {size}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {pack.downloading ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {Math.round(pack.progress * 100)}%
                      </span>
                    ) : !pack.installed ? (
                      <Button size="sm" variant="outline" onClick={() => packs.install(pack.id)}>
                        下载
                      </Button>
                    ) : (
                      <>
                        {pack.upgradable ? (
                          <Button size="sm" variant="outline" onClick={() => packs.install(pack.id)}>
                            升级
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant={pack.active ? 'ghost' : 'secondary'}
                          disabled={pack.active || packs.busy}
                          onClick={() => packs.select(pack.id)}
                        >
                          {pack.active ? '正在用' : '使用'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pack.active}
                          title={pack.active ? '先在别处切到另一个音色再删' : undefined}
                          onClick={() => packs.remove(pack.id)}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
          {packs.error ? (
            <p className="border-t border-border/40 px-4 py-2 text-xs text-destructive">{packs.error}</p>
          ) : null}
        </div>
      ) : null}

      {tab === 'refs' ? (
        <>
          <Group label="从库里选">
            <Row
              label="参考音频"
              htmlFor="v2-pack-ref"
              hint="选中即整套换参考，下一句朗读就生效；带「微调」的条目会连权重一起切"
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
            </Row>
            {!seedPresent ? (
              <Row
                label="保底参考"
                hint="用免费的 Edge 嗓子现合成一条晓晓参考写进库里，不下载模型"
              >
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
            {refError ? (
              <Row label="切换失败" hint="服务或权重没起来，看 GV 服务那一页">
                <StatusPill tone="bad">{refError}</StatusPill>
              </Row>
            ) : null}
          </Group>

          <Group label="参考音频的细节">
            <Row
              label="逐字转写"
              htmlFor="v2-pack-prompt"
              hint="参考音频说了什么，一字不差；对不上音质会明显劣化"
            >
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
        </>
      ) : null}

      {tab === 'server' ? (
        <>
          <Group label="引擎与地址">
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
          </Group>

          <Group label="运行状态">
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
                    <span className="text-xs tabular-nums text-muted-foreground">
                      PID {status.server.pid}
                    </span>
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
                <pre className="max-h-48 w-full overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-4 text-muted-foreground">
                  {status.logs.join('\n')}
                </pre>
              </Row>
            ) : null}
          </Group>
        </>
      ) : null}
    </Modal>
  )
}
