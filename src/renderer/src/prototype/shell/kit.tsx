/**
 * 原型的组件层：一行设置、一个开关、一组 chips、一张表，全部按定稿的令牌画。
 *
 * 规则写在组件签名上，不写在文档里：
 * - 一句长说明永远走 `note`（整行、可断词），不许塞进 `control` —— 塞进去就会像 #151 那样把标签压成一字一列。
 * - 颜色只表达三种意思：选中/主操作（accent）、需要注意（warn）、坏了（danger）。其余一律 text / dim。
 * - 每个状态除了颜色还带一个字形（✓ ✕ ⚠ ●），灰度截图也分得清。
 */
import * as React from 'react'

import { C, FS, MONO, SP } from './tokens'

export function Card({
  children,
  style,
  pad
}: {
  children: React.ReactNode
  style?: React.CSSProperties
  pad?: number
}): React.ReactElement {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: pad ?? SP.card,
        marginBottom: SP.gap,
        ...style
      }}
    >
      {children}
    </div>
  )
}

export function SectionTitle({
  children,
  note
}: {
  children: React.ReactNode
  note?: string
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: FS.title, fontWeight: 600, letterSpacing: 0.1 }}>{children}</div>
      {note ? (
        <div style={{ fontSize: FS.small, color: C.dim, marginTop: 3, lineHeight: 1.55 }}>
          {note}
        </div>
      ) : null}
    </div>
  )
}

/** 状态字：颜色 ＋ 字形，两个都要有。 */
const MARKS = { ok: '✓', warn: '⚠', bad: '✕', idle: '●' } as const

export function Pill({
  tone = 'idle',
  children
}: {
  tone?: keyof typeof MARKS
  children: React.ReactNode
}): React.ReactElement {
  const color =
    tone === 'ok' ? C.accent : tone === 'warn' ? C.warn : tone === 'bad' ? C.danger : C.dim
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: FS.mini,
        color,
        border: `1px solid ${color}44`,
        background: `${color}12`,
        borderRadius: 999,
        padding: '1px 8px',
        whiteSpace: 'nowrap'
      }}
    >
      <span aria-hidden>{MARKS[tone]}</span>
      {children}
    </span>
  )
}

/** 一行设置：左边标签（可带一句说明），右边控件；整句说明走 note 独占一行。 */
export function Row({
  label,
  hint,
  note,
  noteTone = 'dim',
  control,
  children,
  stacked,
  last
}: {
  label: string
  hint?: string
  /** 一整句话：独占一行、可断词，永远不参与「标签 / 控件」的宽度竞争 */
  note?: React.ReactNode
  noteTone?: 'dim' | 'warn' | 'bad' | 'ok'
  control?: React.ReactNode
  /** 直接写在 Row 里的控件（等价于 control，写起来更短） */
  children?: React.ReactNode
  /** 控件比标签宽（滑块、模板、代码块）时另起一行 */
  stacked?: boolean
  last?: boolean
}): React.ReactElement {
  const noteColor =
    noteTone === 'warn'
      ? C.warn
      : noteTone === 'bad'
        ? C.danger
        : noteTone === 'ok'
          ? C.accent
          : C.dim
  const head = (
    <>
      <span style={{ fontSize: FS.body, color: C.text }}>{label}</span>
      {hint ? (
        <span style={{ fontSize: FS.small, color: C.dim, marginLeft: 8 }}>{hint}</span>
      ) : null}
    </>
  )
  return (
    <div
      style={{
        padding: stacked ? '9px 0' : '7px 0',
        borderBottom: last ? 'none' : `1px solid ${C.line}`
      }}
    >
      {stacked ? (
        <div>{head}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px' }}>
          <div style={{ flex: '1 1 12rem', minWidth: 0 }}>{head}</div>
          <div
            style={{
              flex: '0 0 auto',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6
            }}
          >
            {control}
          </div>
        </div>
      )}
      {stacked && (control ?? children) ? (
        <div style={{ marginTop: 6 }}>{control ?? children}</div>
      ) : null}
      {note ? (
        <div
          style={{
            marginTop: 4,
            fontSize: FS.small,
            lineHeight: 1.6,
            color: noteColor,
            wordBreak: 'break-word'
          }}
        >
          {note}
        </div>
      ) : null}
    </div>
  )
}

export function Btn({
  children,
  primary,
  small,
  onClick,
  disabled,
  title
}: {
  children: React.ReactNode
  primary?: boolean
  small?: boolean
  onClick?: () => void
  disabled?: boolean
  title?: string
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        background: primary ? C.accent : 'transparent',
        color: primary ? '#04120c' : C.text,
        border: `1px solid ${primary ? C.accent : C.line2}`,
        borderRadius: 7,
        fontSize: small ? FS.mini : FS.small,
        fontWeight: primary ? 600 : 400,
        padding: small ? '3px 9px' : '5px 11px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1
      }}
    >
      {children}
    </button>
  )
}

export function Toggle({
  on,
  onChange,
  label
}: {
  on: boolean
  onChange: (next: boolean) => void
  label?: string
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        color: on ? C.text : C.dim,
        fontSize: FS.small
      }}
    >
      <span
        style={{
          width: 30,
          height: 17,
          borderRadius: 999,
          background: on ? `${C.accent}33` : 'rgba(255,255,255,0.09)',
          border: `1px solid ${on ? C.accent : C.line2}`,
          position: 'relative',
          transition: 'background 120ms'
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1.5,
            left: on ? 14 : 2,
            width: 12,
            height: 12,
            borderRadius: 999,
            background: on ? C.accent : C.dim,
            transition: 'left 120ms'
          }}
        />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
  )
}

/** 平铺的一组选项（字号三档、显示模式四档这类）。选中才用 accent。 */
export function Chips<T extends string>({
  options,
  value,
  onChange
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (next: T) => void
}): React.ReactElement {
  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              background: on ? `${C.accent}1a` : 'transparent',
              color: on ? C.accent : C.dim,
              border: `1px solid ${on ? `${C.accent}66` : C.line2}`,
              borderRadius: 6,
              fontSize: FS.mini,
              padding: '3px 9px',
              cursor: 'pointer'
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 下拉：原型里用真 select，行为与面板一致（点开、选中、关闭）。 */
export function SelectBox<T extends string>({
  options,
  value,
  onChange,
  width
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (next: T) => void
  width?: number
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      style={{
        background: C.card2,
        color: C.text,
        border: `1px solid ${C.line2}`,
        borderRadius: 7,
        fontSize: FS.small,
        padding: '4px 7px',
        width,
        cursor: 'pointer'
      }}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** 进度 / 电平 / 滑块共用一条：值只在 0..1。 */
export function Bar({
  value,
  tone = 'accent',
  height = 4,
  label
}: {
  value: number
  tone?: 'accent' | 'warn' | 'dim'
  height?: number
  label?: string
}): React.ReactElement {
  const color = tone === 'warn' ? C.warn : tone === 'dim' ? C.dim : C.accent
  return (
    <div>
      <div
        style={{
          height,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 999,
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            width: `${Math.round(value * 100)}%`,
            height,
            background: color,
            transition: 'width 180ms'
          }}
        />
      </div>
      {label ? <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>{label}</div> : null}
    </div>
  )
}

/** 键值对网格：设备 id、路径、时间戳这类「抄下来就能用」的东西。 */
export function KV({
  items,
  columns = 1
}: {
  items: [string, string][]
  columns?: number
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: '3px 18px'
      }}
    >
      {items.map(([k, v]) => (
        <div
          key={k}
          style={{ display: 'flex', gap: 8, fontSize: FS.small, padding: '2px 0', minWidth: 0 }}
        >
          <span style={{ flex: '0 0 auto', color: C.dim, fontFamily: MONO }}>{k}</span>
          <span
            style={{ minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {v}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 一张小表：训练记录、识别记录、翻译记账本都用它。 */
export function Table({
  head,
  rows,
  empty = '还没有记录'
}: {
  head: string[]
  rows: React.ReactNode[][]
  empty?: string
}): React.ReactElement {
  if (rows.length === 0) return <div style={{ fontSize: FS.small, color: C.dim }}>{empty}</div>
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${head.length}, minmax(0, 1fr))`,
          gap: 10,
          background: C.card2,
          padding: '6px 10px',
          fontSize: FS.mini,
          color: C.dim
        }}
      >
        {head.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${head.length}, minmax(0, 1fr))`,
            gap: 10,
            padding: '6px 10px',
            fontSize: FS.small,
            borderTop: i === 0 ? 'none' : `1px solid ${C.line}`,
            alignItems: 'baseline'
          }}
        >
          {r.map((cell, j) => (
            <span
              key={j}
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** 一条横向提示条：警告走 warn，坏了走 danger。 */
export function Banner({
  tone = 'warn',
  title,
  children,
  action
}: {
  tone?: 'warn' | 'bad' | 'info'
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}): React.ReactElement {
  const color = tone === 'bad' ? C.danger : tone === 'info' ? C.info : C.warn
  return (
    <div
      style={{
        border: `1px solid ${color}44`,
        background: `${color}10`,
        borderRadius: 8,
        padding: '9px 11px',
        marginBottom: 8
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: FS.small, color, fontWeight: 600, flex: '0 0 auto' }}>
          {tone === 'bad' ? '✕' : tone === 'info' ? '●' : '⚠'} {title}
        </span>
        <span
          style={{
            flex: '1 1 16rem',
            minWidth: 0,
            fontSize: FS.small,
            color: C.dim,
            lineHeight: 1.6
          }}
        >
          {children}
        </span>
        {action ? <span style={{ flex: '0 0 auto' }}>{action}</span> : null}
      </div>
    </div>
  )
}

/** 滑块：值自己带单位显示在右边，避免「拖了但不知道拖到哪」。 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (next: number) => void
  suffix?: string
}): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 132, accentColor: C.accent, cursor: 'pointer' }}
      />
      <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.text, minWidth: 44 }}>
        {value}
        {suffix ?? ''}
      </span>
    </span>
  )
}
