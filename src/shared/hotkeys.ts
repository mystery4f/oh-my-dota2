/**
 * 全局热键的纯规则：动作表、accelerator 归一化与合法性、冲突检测、录制器判定、显示格式化。
 *
 * 这里刻意不 import electron / fs / DOM —— 面板、主进程和探针共用同一套规则，
 * 规则写错只会在「按了没反应」时才暴露，所以必须能被探针逐条钉死。
 *
 * 术语：**动作（hotkey action）** 是可以挂一个组合键的行为；空串 = 不绑（unbound），
 * 不是「非法」。**说话键**是另一回事（按进游戏的单键），不在这张表里。
 */

export type HotkeyActionId =
  | 'overlayToggle'
  | 'overlayLock'
  | 'overlayCollapse'
  | 'inplaceSend'
  | 'overlayPanel'
  | 'voiceCapture'

export interface HotkeyAction {
  id: HotkeyActionId
  /** 面板上显示的中文名。 */
  label: string
  /** 一句话说明这个键干什么，免得用户只看名字猜。 */
  hint: string
  /** 出厂组合键（canonical 写法）。 */
  defaultAccelerator: string
}

/** 动作表：顺序就是面板里的顺序。 */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  {
    id: 'overlayToggle',
    label: '显示/隐藏浮层',
    hint: '收起的小图标状态下也用这个键找回来',
    defaultAccelerator: 'Alt+Shift+O'
  },
  {
    id: 'overlayLock',
    label: '锁定/解锁浮层',
    hint: '锁定后鼠标穿透；解锁才能拖动和改宽度',
    defaultAccelerator: 'Alt+Shift+P'
  },
  {
    id: 'overlayCollapse',
    label: '收起/展开小图标',
    hint: '收起后是穿透的，只能靠这个键展开',
    defaultAccelerator: 'Alt+Shift+B'
  },
  {
    id: 'inplaceSend',
    label: '原地直发',
    hint: '读游戏聊天框里打好未发送的中文，翻译贴回并回车',
    defaultAccelerator: 'Alt+Shift+T'
  },
  {
    id: 'overlayPanel',
    label: '呼出面板',
    hint: '把浮层临时变成可交互面板：历史、快捷短语、AI 建议回复；再按或 Esc 关闭',
    defaultAccelerator: 'Alt+Shift+H'
  },
  {
    id: 'voiceCapture',
    label: '语音对讲',
    hint: '按住说话、松开触发；也可以设成敲一下开始、再敲一下结束（见下方「语音对讲怎么按」）',
    defaultAccelerator: 'Alt+Shift+V'
  }
] as const

/** 语音对讲热键的两种按法：hold 按住说话、松开触发；toggle 按一下开录、再按一下触发。 */
export type CaptureMode = 'hold' | 'toggle'

/** 出厂按法：按住说话最接近玩家的肌肉记忆，也不怕忘了关麦。 */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'hold'

/** 只认两个合法值；乱填打回 hold（toggle 的坏值后果是「录了不知道停」）。 */
export function normalizeCaptureMode(raw: unknown): CaptureMode {
  return raw === 'toggle' ? 'toggle' : 'hold'
}

/**
 * 录音中横幅那句提示：按住模式说「松开结束」，敲一下模式点名那个键。
 * 两种模式结束方式不同，同一句文案会让用户对着「按一下结束」按住不放。
 */
export function recordingStageLine(mode: CaptureMode, key: string): string {
  if (mode === 'hold') return '● 录音中 · 松开结束'
  return key ? `● 录音中 · ${key} 结束` : '● 录音中'
}

export type HotkeyMap = Record<HotkeyActionId, string>

export const HOTKEY_ACTION_IDS: readonly HotkeyActionId[] = HOTKEY_ACTIONS.map(
  (action) => action.id
) as readonly HotkeyActionId[]

export const DEFAULT_HOTKEYS: HotkeyMap = Object.fromEntries(
  HOTKEY_ACTIONS.map((action) => [action.id, action.defaultAccelerator])
) as HotkeyMap

/** 注册结果：主进程抢到了 / 被别的软件占了 / 这个动作没绑键。 */
export type HotkeyVerdict = 'accepted' | 'rejected' | 'unbound'

export interface HotkeyActionState extends HotkeyAction {
  /** canonical 组合键；空串 = 未绑定。 */
  accelerator: string
  /** 给人看的写法（Super 显示成 Win，空串显示成「未绑定」）。 */
  display: string
  verdict: HotkeyVerdict
}

export interface HotkeyState {
  actions: HotkeyActionState[]
}

export const UNBOUND_LABEL = '未绑定'

/** canonical 修饰键顺序：Ctrl、Alt、Shift、Super。 */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

/** 修饰键的各种别名（面板录制器、手编 settings.json 都可能给别的写法）。 */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  win: 'Super',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super'
}

/** Electron 认的具名键。 */
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  printscreen: 'PrintScreen',
  prtsc: 'PrintScreen',
  plus: 'Plus',
  numlock: 'Numlock',
  capslock: 'Capslock',
  scrolllock: 'Scrolllock',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute'
}

/** 允许原样保留的标点键（Electron 直接吃字符）。'+' 例外，必须写成 Plus。 */
const PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'])

/** F1–F24：唯一允许「不带修饰键单独用」的键——不会抢走游戏里的打字。 */
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/

/**
 * 主键归一化：'o' → 'O'，'f5' → 'F5'，'plus'/'+' → 'Plus'，认不出返回 null。
 */
export function normalizeMainKey(raw: string): string | null {
  const text = (typeof raw === 'string' ? raw : '').trim()
  if (!text) return null
  if (text === '+') return 'Plus'
  const lower = text.toLowerCase()
  const named = NAMED_KEYS[lower]
  if (named) return named
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') return lower.toUpperCase()
  if (lower.length === 1 && lower >= '0' && lower <= '9') return lower
  if (FUNCTION_KEY.test(text.toUpperCase())) return text.toUpperCase()
  if (text.length === 1 && PUNCTUATION.has(text)) return text
  return null
}

/** 修饰键归一化：'alt' → 'Alt'，认不出返回 null。 */
export function normalizeModifier(raw: string): Modifier | null {
  const text = (typeof raw === 'string' ? raw : '').trim().toLowerCase()
  if (!text) return null
  return MODIFIER_ALIASES[text] ?? null
}

export interface ParsedAccelerator {
  modifiers: Modifier[]
  key: string
}

/** 拆开 accelerator；任何一段认不出就整条不合法（返回 null）。 */
export function parseAccelerator(raw: string): ParsedAccelerator | null {
  const text = (typeof raw === 'string' ? raw : '').trim()
  if (!text) return null
  // 'Ctrl++' 是「Ctrl 加号键」的写法：先把它换成 Plus 再拆，否则空段会被过滤掉、只剩 Ctrl。
  const normalizedText = text.endsWith('++') ? `${text.slice(0, -2)}+Plus` : text
  const parts = normalizedText.split('+').filter((part) => part.trim() !== '')
  if (parts.length === 0) return null
  const modifiers: Modifier[] = []
  let key: string | null = null
  for (const part of parts) {
    const modifier = normalizeModifier(part)
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }
    // 主键只能有一个：'Ctrl+A+B' 属于手误，不猜。
    if (key !== null) return null
    key = normalizeMainKey(part)
    if (key === null) return null
  }
  if (key === null) return null
  return { modifiers, key }
}

/** 主键本身能不能独立成键：只有 F1–F24。 */
export function isStandaloneKey(key: string): boolean {
  return FUNCTION_KEY.test(key)
}

/**
 * canonical 写法：修饰键固定顺序、主键大写。空串是「未绑定」，原样返回空串；
 * 认不出返回 null（调用方要打回默认值）。
 */
export function normalizeAccelerator(raw: string): string | null {
  const text = (typeof raw === 'string' ? raw : '').trim()
  if (!text) return ''
  const parsed = parseAccelerator(text)
  if (!parsed) return null
  // 不带修饰键又不是功能键：抢的是游戏里的打字，一律不合法。
  if (parsed.modifiers.length === 0 && !isStandaloneKey(parsed.key)) return null
  const ordered = MODIFIER_ORDER.filter((modifier) => parsed.modifiers.includes(modifier))
  return [...ordered, parsed.key].join('+')
}

/**
 * accelerator → 物理键码（VK）。按住检测只能靠 GetAsyncKeyState 轮询，
 * 而这套轮询必须拿到组合里每一个键的 VK；认不出的键返回 null，
 * 调用方退回 globalShortcut 的「敲一下」注册——热键绝不能变哑。
 */
const MODIFIER_VKS: Record<Modifier, number> = { Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Super: 0x5b }

const NAMED_VKS: Record<string, number> = {
  Space: 0x20,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  Delete: 0x2e,
  Insert: 0x2d,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  PrintScreen: 0x2c,
  Numlock: 0x90,
  Capslock: 0x14,
  Scrolllock: 0x91,
  VolumeUp: 0xaf,
  VolumeDown: 0xae,
  VolumeMute: 0xad,
  Plus: 0xbb
}

/** 标点键各占一个 OEM 码，跟字符的 ASCII 无关；把 `;` 和 `'` 弄反是最常见的错。 */
const PUNCTUATION_VKS: Record<string, number> = {
  '-': 0xbd,
  '=': 0xbb,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc,
  ';': 0xba,
  "'": 0xde,
  ',': 0xbc,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0
}

function mainKeyVk(key: string): number | null {
  if (key.length === 1) {
    const code = key.charCodeAt(0)
    // 字母的 VK 就是大写 ASCII，数字同理。
    if (code >= 65 && code <= 90) return code
    if (code >= 48 && code <= 57) return code
    return PUNCTUATION_VKS[key] ?? null
  }
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key)
  if (functionKey) return 0x6f + Number(functionKey[1])
  return NAMED_VKS[key] ?? null
}

/** canonical accelerator → VK 列表（修饰键在前、主键在后）；空串或认不出返回 null。 */
export function acceleratorVks(accelerator: string): number[] | null {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return null
  const key = mainKeyVk(parsed.key)
  if (key === null) return null
  return [...parsed.modifiers.map((modifier) => MODIFIER_VKS[modifier]), key]
}
/** 给人看的写法：Super 在 Windows 上叫 Win。 */
export function formatAccelerator(accelerator: string): string {
  if (!accelerator) return UNBOUND_LABEL
  return accelerator.split('+').map((part) => (part === 'Super' ? 'Win' : part)).join('+')
}

export interface HotkeyConflict {
  ids: [HotkeyActionId, HotkeyActionId]
  accelerator: string
}

/** 两处填同一个键：返回所有冲突对。未绑定不算冲突。 */
export function findHotkeyConflicts(map: Partial<HotkeyMap>): HotkeyConflict[] {
  const byKey = new Map<string, HotkeyActionId[]>()
  for (const id of HOTKEY_ACTION_IDS) {
    const accelerator = normalizeAccelerator(map[id] ?? '')
    if (!accelerator) continue
    const list = byKey.get(accelerator) ?? []
    list.push(id)
    byKey.set(accelerator, list)
  }
  const conflicts: HotkeyConflict[] = []
  for (const [accelerator, ids] of byKey) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        conflicts.push({ ids: [ids[i], ids[j]], accelerator })
      }
    }
  }
  return conflicts
}

/**
 * 逐项兜底：未知动作 id 丢掉，非字符串/非法值回落到该动作的默认键。
 * 整份缺表 = 全部默认——绝不因为一个键写坏把其它几个一起废掉。
 */
export function normalizeHotkeyMap(raw: unknown): HotkeyMap {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const map = {} as HotkeyMap
  for (const action of HOTKEY_ACTIONS) {
    const value = source[action.id]
    const normalized = typeof value === 'string' ? normalizeAccelerator(value) : null
    map[action.id] = normalized === null ? action.defaultAccelerator : normalized
  }
  return map
}

/** 录制器读到的一次按键（不依赖 DOM 类型，渲染端自己拼）。 */
export interface KeyChordInput {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** 录制到的组合键为什么不能用：只有「少了修饰键」一种——认不出的主键在录制阶段就当待定，不算填好。 */
export type HotkeyProblem = 'need-modifier'

export type ChordResult =
  /** 只按了修饰键（或认不出的键）：给个待定预览，不当成填好。 */
  | { complete: false; pending: string }
  /** 按全了：accelerator 是 canonical 写法；problem 非空时该拒绝并显示原因。 */
  | { complete: true; accelerator: string; problem: HotkeyProblem | null }

const MODIFIER_KEY_NAMES = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'])

function heldModifiers(input: KeyChordInput): Modifier[] {
  const held: Modifier[] = []
  if (input.ctrlKey) held.push('Ctrl')
  if (input.altKey) held.push('Alt')
  if (input.shiftKey) held.push('Shift')
  if (input.metaKey) held.push('Super')
  return held
}

/**
 * 录制器判定：修饰键单独按不算填好（否则按 Shift 就把键填了）；
 * 主键认不出也不填；填好后不带修饰键的普通键要标 need-modifier 让面板拒绝。
 */
export function chordFromKeyEvent(input: KeyChordInput): ChordResult {
  const held = heldModifiers(input)
  if (MODIFIER_KEY_NAMES.has(input.key)) {
    return { complete: false, pending: held.length === 0 ? '按下组合键…' : `${held.join('+')}+` }
  }
  const key = normalizeMainKey(input.key)
  if (key === null) {
    return { complete: false, pending: held.length === 0 ? '这个键不支持' : `${held.join('+')}+` }
  }
  const accelerator = [...held, key].join('+')
  const problem: HotkeyProblem | null =
    held.length === 0 && !isStandaloneKey(key) ? 'need-modifier' : null
  return { complete: true, accelerator, problem }
}


/** 面板/IPC 共用的状态表：动作表 + 当前键 + 注册结果。 */
export function describeHotkeys(
  map: Partial<HotkeyMap>,
  verdicts: Partial<Record<HotkeyActionId, HotkeyVerdict>> = {}
): HotkeyState {
  const normalized = normalizeHotkeyMap(map)
  return {
    actions: HOTKEY_ACTIONS.map((action) => {
      const accelerator = normalized[action.id]
      return {
        ...action,
        accelerator,
        display: formatAccelerator(accelerator),
        verdict: verdicts[action.id] ?? (accelerator ? 'accepted' : 'unbound')
      }
    })
  }
}
