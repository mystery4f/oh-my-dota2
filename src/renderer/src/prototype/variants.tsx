// PROTOTYPE (throwaway): three structurally different redesigns of the settings
// panel, switched by ?variant= + the floating bottom bar (← → keys work too).
//   A 驾驶舱 — left sidebar nav, one section at a time, premium tool look.
//   B 对局台 — top game-HUD nav, status orb, HUD panels + status rail.
//   C 指挥台 — no nav at all: one canvas, command search filters groups.
// Fake data only (./fake-data). Settle ONE direction with the user, fold it
// into a real App rewrite, then delete this folder together with the gates in
// main.tsx / main/index.ts.
import { useEffect, useMemo, useState } from 'react'
import { sections, statusChips, type Chip, type SectionRow, type Tone } from './fake-data'

const VARIANTS = [
  { key: 'a', name: '驾驶舱 Sidebar' },
  { key: 'b', name: '对局台 HUD' },
  { key: 'c', name: '指挥台 Search' }
]

export function PanelPrototype({ initialVariant }: { initialVariant: string }) {
  const [vi, setVi] = useState(() => {
    const i = VARIANTS.findIndex((v) => v.key === initialVariant)
    return i === -1 ? 0 : i
  })
  const cycle = (d: number) => {
    const next = (vi + d + VARIANTS.length) % VARIANTS.length
    setVi(next)
    history.replaceState(null, '', `?variant=${VARIANTS[next].key}`)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') cycle(-1)
      if (e.key === 'ArrowRight') cycle(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const current = VARIANTS[vi]
  return (
    <>
      {vi === 0 && <VariantA />}
      {vi === 1 && <VariantB />}
      {vi === 2 && <VariantC />}
      <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 flex items-center gap-1 rounded-full border border-white/20 bg-black/85 px-2 py-1.5 text-xs text-white shadow-[0_8px_30px_rgba(0,0,0,0.6)] backdrop-blur">
        <button
          className="rounded-full px-2 py-0.5 hover:bg-white/15"
          onClick={() => cycle(-1)}
          title="上一个原型（←）"
        >
          ←
        </button>
        <span className="px-2 font-medium tracking-wide">
          {current.key.toUpperCase()} · {current.name}
        </span>
        <button
          className="rounded-full px-2 py-0.5 hover:bg-white/15"
          onClick={() => cycle(1)}
          title="下一个原型（→）"
        >
          →
        </button>
      </div>
    </>
  )
}

/* ---------------------------------------------------------------- */
/* A 驾驶舱 — sidebar nav, one section at a time, restrained accent. */
/* ---------------------------------------------------------------- */

const A_NAV: { group: string; items: { id: string; label: string; dot?: Tone }[] }[] = [
  {
    group: '对局',
    items: [
      { id: 'talk', label: '对讲' },
      { id: 'chatout', label: '直发' },
      { id: 'announce', label: '朗读' },
      { id: 'overlay', label: '浮层与对局' }
    ]
  },
  {
    group: '系统',
    items: [
      { id: 'hotkeys', label: '热键', dot: 'warn' },
      { id: 'engine', label: '翻译引擎' }
    ]
  }
]

function AToneDot({ tone }: { tone: Tone }) {
  const c = tone === 'warn' ? 'bg-amber-400' : tone === 'ok' ? 'bg-emerald-400' : 'bg-zinc-600'
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${c}`} />
}

function AChip({ chip }: { chip: Chip }) {
  const tone =
    chip.tone === 'ok'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
      : chip.tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>{chip.label}</span>
}

function AControl({ row }: { row: SectionRow }) {
  if (row.control === 'toggle')
    return (
      <span
        className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 ${row.on ? 'bg-orange-600/90 justify-end' : 'bg-zinc-700 justify-start'}`}
      >
        <span className="h-4 w-4 rounded-full bg-white shadow" />
      </span>
    )
  if (row.control === 'key')
    return (
      <span
        className={`rounded-md border px-2 py-1 font-mono text-xs ${row.tone === 'warn' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-zinc-700 bg-zinc-800 text-zinc-200'}`}
      >
        {row.value}
      </span>
    )
  if (row.control === 'slider')
    return (
      <span className="flex items-center gap-2">
        <span className="relative h-1 w-28 rounded-full bg-zinc-700">
          <span className="absolute left-0 top-0 h-1 w-3/4 rounded-full bg-orange-600/80" />
          <span className="absolute top-1/2 left-3/4 h-3 w-3 -translate-y-1/2 rounded-full bg-zinc-100" />
        </span>
        <span className="font-mono text-xs text-zinc-400">{row.value}</span>
      </span>
    )
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/70 px-2.5 py-1 text-xs ${row.tone === 'warn' ? 'text-amber-300' : 'text-zinc-200'}`}
    >
      {row.value}
      {row.control === 'select' && <span className="text-zinc-500">▾</span>}
    </span>
  )
}

function VariantA() {
  const [active, setActive] = useState('talk')
  const section = sections.find((s) => s.id === active) ?? sections[0]
  return (
    <div className="flex h-screen overflow-hidden bg-[#09090b] text-[13px] text-zinc-300">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[#1b1b1f] bg-[#0b0b0d]">
        <div className="flex h-14 items-center gap-2.5 border-b border-[#1b1b1f] px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-orange-600 text-[11px] font-bold text-black">
            D2
          </div>
          <div>
            <div className="font-medium text-zinc-100">oh-my-dota2</div>
            <div className="text-[10px] text-zinc-600">面板 · 原型 A</div>
          </div>
        </div>
        <nav className="flex-1 overflow-auto py-2">
          {A_NAV.map((g) => (
            <div key={g.group}>
              <div className="px-4 pt-4 pb-1.5 text-[10px] tracking-widest text-zinc-600 uppercase">{g.group}</div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => setActive(it.id)}
                  className={`flex w-full items-center gap-2 px-4 py-1.5 text-left ${active === it.id ? 'bg-orange-600/10 text-orange-200' : 'text-zinc-400 hover:bg-zinc-800/30 hover:text-zinc-200'}`}
                >
                  <span className="flex-1">{it.label}</span>
                  {it.dot && <AToneDot tone={it.dot} />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-[#1b1b1f] p-3">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px] text-amber-300">
            v3.4.1 可用 — 重启后安装
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[#1b1b1f] px-6">
          <h1 className="text-[15px] font-medium text-zinc-100">{section.title}</h1>
          <span className="text-xs text-zinc-600">{section.sub}</span>
          <div className="ml-auto flex gap-1.5">
            {statusChips.map((c) => (
              <AChip key={c.label} chip={c} />
            ))}
          </div>
        </header>
        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-[#1b1b1f] bg-[#0d0d10]">
            {section.chips.length > 0 && (
              <div className="flex gap-1.5 border-b border-[#1b1b1f] px-4 py-2.5">
                {section.chips.map((c) => (
                  <AChip key={c.label} chip={c} />
                ))}
              </div>
            )}
            <div className="divide-y divide-[#161619]">
              {section.rows.map((row) => (
                <div key={row.label} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-zinc-200">{row.label}</div>
                    {row.hint && <div className="mt-0.5 text-[11px] text-zinc-600">{row.hint}</div>}
                  </div>
                  <AControl row={row} />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 text-[11px] text-zinc-700">原型 A：侧边栏分区，一屏一节，高级项后续按折叠处理。数据是假的。</div>
        </div>
      </main>
    </div>
  )
}

/* --------------------------------------------------------------- */
/* B 对局台 — top game HUD, status orb, angular glowing panels.      */
/* --------------------------------------------------------------- */

const B_CUT = '[clip-path:polygon(10px_0,100%_0,100%_calc(100%_-_10px),calc(100%_-_10px)_100%,0_100%,0_10px)]'

function BTone(tone?: Tone): string {
  if (tone === 'warn') return 'text-amber-300'
  if (tone === 'ok') return 'text-emerald-300'
  return 'text-zinc-100'
}

function BChip({ chip }: { chip: Chip }) {
  const tone =
    chip.tone === 'ok'
      ? 'border-emerald-400/30 text-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.15)]'
      : chip.tone === 'warn'
        ? 'border-amber-400/40 text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.2)]'
        : 'border-zinc-600/40 text-zinc-400'
  return (
    <span className={`border px-2 py-0.5 text-[10px] tracking-wider whitespace-nowrap ${tone} ${B_CUT} bg-black/40`}>{chip.label}</span>
  )
}

function BControl({ row }: { row: SectionRow }) {
  if (row.control === 'toggle')
    return (
      <span
        className={`inline-flex h-5 w-9 items-center rounded-sm px-0.5 ${row.on ? 'justify-end bg-red-600/80 shadow-[0_0_10px_rgba(220,38,38,0.4)]' : 'justify-start bg-zinc-700'}`}
      >
        <span className="h-4 w-4 bg-zinc-100" />
      </span>
    )
  if (row.control === 'key')
    return (
      <span className={`border border-[#5a4a2a] bg-black/50 px-2 py-1 font-mono text-xs ${BTone(row.tone)} ${B_CUT}`}>
        {row.value}
      </span>
    )
  if (row.control === 'slider')
    return (
      <span className="flex items-center gap-2">
        <span className="relative h-1.5 w-28 bg-zinc-800">
          <span className="absolute top-0 left-0 h-1.5 w-3/4 bg-gradient-to-r from-red-700 to-amber-400" />
        </span>
        <span className="font-mono text-xs text-amber-200">{row.value}</span>
      </span>
    )
  return (
    <span className={`inline-flex items-center gap-1.5 border border-[#2a2f3a] bg-black/50 px-2.5 py-1 font-mono text-xs ${B_CUT} ${BTone(row.tone)}`}>
      {row.value}
      {row.control === 'select' && <span className="text-zinc-500">▾</span>}
    </span>
  )
}

function VariantB() {
  const [active, setActive] = useState('talk')
  const section = sections.find((s) => s.id === active) ?? sections[0]
  const status = sections.find((s) => s.id === 'engine')!
  return (
    <div className="h-screen overflow-hidden bg-[#07090d] text-[13px] text-zinc-300" style={{ backgroundImage: 'radial-gradient(1200px 500px at 50% -10%, #12141c 0%, #07090d 60%)' }}>
      {/* top HUD */}
      <div className="flex h-16 items-center gap-4 border-b border-[#2a2018] bg-gradient-to-b from-[#12100c] to-[#0b0a08] px-5">
        <div className={`${B_CUT} flex items-center gap-2 border border-[#5a4a2a] bg-black/60 px-3 py-1.5`}>
          <span className="font-bold tracking-widest text-amber-300">OMD2</span>
          <span className="text-[10px] tracking-widest text-zinc-500">对局面板 · 原型 B</span>
        </div>
        <nav className="flex gap-1">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={`${B_CUT} whitespace-nowrap px-3 py-1.5 tracking-wide ${active === s.id ? 'border border-red-800/60 bg-red-950/40 text-red-200 shadow-[0_0_16px_rgba(220,38,38,0.25)]' : 'border border-transparent text-zinc-500 hover:text-zinc-200'}`}
            >
              {s.title}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          {statusChips.slice(0, 2).map((c) => (
            <BChip key={c.label} chip={c} />
          ))}
          <div className="flex items-center gap-2">
            <span className="relative flex h-9 w-9 items-center justify-center">
              <span className="absolute inset-0 animate-pulse rounded-full border border-emerald-400/40 shadow-[0_0_18px_rgba(52,211,153,0.35)]" />
              <span className="h-4 w-4 rounded-full bg-emerald-400/90 shadow-[0_0_10px_rgba(52,211,153,0.8)]" />
            </span>
            <div className="leading-tight">
              <div className="whitespace-nowrap text-[11px] text-emerald-300">引擎就绪</div>
              <div className="font-mono text-[10px] whitespace-nowrap text-zinc-500">{status.rows[1].value}</div>
            </div>
          </div>
        </div>
      </div>
      {/* content: main panel + status rail */}
      <div className="flex gap-4 p-5 pb-16">
        <section className={`${B_CUT} min-w-0 flex-1 border border-[#2a2f3a] bg-[#0d1017]/90 shadow-[0_0_30px_rgba(0,0,0,0.5)]`}>
          <div className="flex items-center justify-between border-b border-[#2a2f3a] bg-gradient-to-r from-[#161a23] to-transparent px-4 py-3">
            <div>
              <h2 className="tracking-widest text-amber-200">{section.title}</h2>
              <p className="mt-0.5 text-[11px] text-zinc-500">{section.sub}</p>
            </div>
            <div className="flex gap-1.5">
              {section.chips.map((c) => (
                <BChip key={c.label} chip={c} />
              ))}
            </div>
          </div>
          <div className="divide-y divide-[#1a1e27]">
            {section.rows.map((row) => (
              <div key={row.label} className="flex items-center gap-4 px-4 py-3 hover:bg-white/[0.02]">
                <div className="min-w-0 flex-1">
                  <div className={BTone(row.tone)}>{row.label}</div>
                  {row.hint && <div className="mt-0.5 text-[11px] text-zinc-600">{row.hint}</div>}
                </div>
                <BControl row={row} />
              </div>
            ))}
          </div>
        </section>
        <aside className="w-72 shrink-0 space-y-3">
          {sections
            .filter((s) => s.id !== active)
            .slice(0, 4)
            .map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={`${B_CUT} block w-full border border-[#2a2f3a] bg-[#0d1017]/70 px-4 py-3 text-left hover:border-[#3a4152] hover:bg-[#12161f]`}
              >
                <div className="flex items-center justify-between">
                  <span className="tracking-widest whitespace-nowrap text-zinc-300">{s.title}</span>
                  <span className="ml-2 shrink-0 font-mono text-[10px] text-zinc-600">›</span>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  {s.chips.slice(0, 2).map((c) => (
                    <BChip key={c.label} chip={c} />
                  ))}
                </div>
              </button>
            ))}
          <div className={`${B_CUT} border border-amber-500/30 bg-amber-950/20 px-4 py-3`}>
            <div className="text-amber-300">更新 v3.4.1</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">重启后安装 · 不在对局中打扰</div>
          </div>
        </aside>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- */
/* C 指挥台 — no nav: one canvas, search filters stacked groups.   */
/* ------------------------------------------------------------- */

function CTone(tone?: Tone): string {
  if (tone === 'warn') return 'text-amber-300'
  if (tone === 'off') return 'text-zinc-500'
  return 'text-stone-200'
}

function CChip({ chip }: { chip: Chip }) {
  const tone =
    chip.tone === 'ok'
      ? 'text-emerald-400/90'
      : chip.tone === 'warn'
        ? 'text-amber-400/90'
        : 'text-stone-500'
  return <span className={`text-[11px] ${tone}`}>● {chip.label}</span>
}

function CControl({ row }: { row: SectionRow }) {
  if (row.control === 'toggle')
    return (
      <span className={`inline-flex h-5 w-8 items-center rounded-full px-0.5 ${row.on ? 'justify-end bg-stone-300' : 'justify-start bg-stone-700'}`}>
        <span className={`h-4 w-4 rounded-full ${row.on ? 'bg-stone-900' : 'bg-stone-400'}`} />
      </span>
    )
  if (row.control === 'key')
    return <kbd className={`rounded border border-stone-700 bg-stone-900 px-1.5 py-0.5 font-mono text-[11px] ${CTone(row.tone)}`}>{row.value}</kbd>
  if (row.control === 'slider')
    return (
      <span className="flex items-center gap-2">
        <span className="relative h-0.5 w-24 bg-stone-700">
          <span className="absolute top-1/2 left-3/4 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-stone-200" />
        </span>
        <span className="font-mono text-[11px] text-stone-400">{row.value}</span>
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-stone-300">
      {row.value}
      {row.control === 'select' && <span className="text-stone-600">▾</span>}
    </span>
  )
}

function VariantC() {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const query = q.trim().toLowerCase()
  const visible = useMemo(
    () =>
      sections
        .map((s) => ({
          section: s,
          rows: query
            ? s.rows.filter((r) => (r.label + r.value + (r.hint ?? '')).toLowerCase().includes(query))
            : s.rows
        }))
        .filter((g) => !query || g.rows.length > 0 || g.section.title.includes(query)),
    [query]
  )
  return (
    <div className="h-screen overflow-auto bg-[#0c0b09] text-[13px] text-stone-300">
      {/* pinned search */}
      <div className="sticky top-0 z-10 border-b border-stone-800/80 bg-[#0c0b09]/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="text-stone-600">⌕</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索设置：热词、说话键、引擎、语速…"
            className="w-96 bg-transparent text-stone-100 outline-none placeholder:text-stone-600"
          />
          <div className="ml-auto flex items-center gap-4 text-[11px] text-stone-500">
            {statusChips.map((c) => (
              <CChip key={c.label} chip={c} />
            ))}
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-3xl pb-24">
        <div className="px-6 pt-5 pb-1 text-[11px] tracking-widest text-stone-600 uppercase">
          oh-my-dota2 指挥台 · 原型 C — 全部设置一屏，搜索直达
        </div>
        <div className="divide-y divide-stone-800/60">
          {visible.map(({ section, rows }) => {
            const open = !collapsed[section.id]
            return (
              <div key={section.id}>
                <button
                  className="flex w-full items-center gap-3 px-6 py-3.5 text-left hover:bg-white/[0.02]"
                  onClick={() => setCollapsed((m) => ({ ...m, [section.id]: !m[section.id] }))}
                >
                  <span className={`text-stone-600 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
                  <span className="font-medium text-stone-100">{section.title}</span>
                  <span className="text-[11px] text-stone-600">{section.sub}</span>
                  <span className="ml-auto flex gap-3">
                    {section.chips.map((c) => (
                      <CChip key={c.label} chip={c} />
                    ))}
                  </span>
                </button>
                {open &&
                  rows.map((row) => (
                    <div key={row.label} className="flex items-center gap-4 pr-6 pl-12 py-2.5">
                      <div className="min-w-0 flex-1">
                        <span className={CTone(row.tone)}>{row.label}</span>
                        {row.hint && <span className="ml-2 text-[11px] text-stone-600">{row.hint}</span>}
                      </div>
                      <CControl row={row} />
                    </div>
                  ))}
                {open && rows.length === 0 && (
                  <div className="px-12 py-2.5 text-[12px] text-stone-600">无匹配项</div>
                )}
              </div>
            )
          })}
        </div>
        {visible.length === 0 && (
          <div className="px-6 py-10 text-center text-stone-600">没有匹配「{q}」的设置</div>
        )}
        <div className="mt-6 px-6 text-[11px] text-stone-700">
          ↑↓ 浏览 · ←→ 切换原型 · 输入即筛 — 高级项折叠在各自分组内
        </div>
      </div>
    </div>
  )
}
