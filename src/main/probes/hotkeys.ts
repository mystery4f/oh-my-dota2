import { app, globalShortcut } from 'electron'
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  HOTKEY_ACTION_IDS,
  captureKeyClash,
  chordFromKeyEvent,
  describeHotkeys,
  findHotkeyConflicts,
  DEFAULT_CAPTURE_MODE,
  acceleratorVks,
  formatAccelerator,
  normalizeCaptureMode,
  recordingStageLine,
  normalizeAccelerator,
  normalizeHotkeyMap,
  parseAccelerator,
  UNBOUND_LABEL
} from '@shared/hotkeys'

interface Case {
  name: string
  ok: boolean
  detail: string
}

/**
 * 热键纯规则探针：只跑规则，不开窗口、不联网。
 *
 * 这些规则错了只会表现为「按了没反应」或者「改了键下次启动变回去」，
 * 在实机上要靠反复重启才发现，所以逐条钉死：合法性、归一化、冲突、兜底、显示、录制器。
 * 最后再真注册一次默认键，证明 canonical 写法系统认（否则规则自洽但键还是抢不到）。
 */
export function runHotkeyProbe(): void {
  const cases: Case[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    cases.push({ name, ok, detail })
  }

  // 默认表本身必须站得住：每个默认键合法，且五个动作两两不撞。
  const badDefaults = HOTKEY_ACTIONS.filter(
    (action) => normalizeAccelerator(action.defaultAccelerator) !== action.defaultAccelerator
  )
  push(
    '默认键全部合法且已是 canonical 写法',
    badDefaults.length === 0,
    badDefaults.map((item) => item.defaultAccelerator).join(',') || 'ok'
  )
  const defaultConflicts = findHotkeyConflicts(DEFAULT_HOTKEYS)
  push('默认表没有冲突', defaultConflicts.length === 0, JSON.stringify(defaultConflicts))

  // 大小写与修饰键顺序都归一化：不然 alt+shift+o 和 Alt+Shift+O 会被当成两个键。
  push(
    '修饰键顺序被规范',
    normalizeAccelerator('shift+alt+o') === 'Alt+Shift+O',
    String(normalizeAccelerator('shift+alt+o'))
  )
  push(
    '大小写被规范',
    normalizeAccelerator('ALT+SHIFT+O') === 'Alt+Shift+O',
    String(normalizeAccelerator('ALT+SHIFT+O'))
  )
  push(
    'win 与 super 等价',
    normalizeAccelerator('win+x') === 'Super+X' && normalizeAccelerator('cmd+x') === 'Super+X',
    String(normalizeAccelerator('win+x'))
  )

  // 合法性：裸字母会抢游戏打字，功能键不会。
  push('裸字母被拒', normalizeAccelerator('O') === null, String(normalizeAccelerator('O')))
  push('裸数字被拒', normalizeAccelerator('5') === null, String(normalizeAccelerator('5')))
  push('裸功能键允许', normalizeAccelerator('f8') === 'F8', String(normalizeAccelerator('f8')))
  push('空串是未绑定', normalizeAccelerator('') === '', JSON.stringify(normalizeAccelerator('')))
  push('认不出的键被拒', normalizeAccelerator('Foo+Bar') === null, String(normalizeAccelerator('Foo+Bar')))
  push('一个组合只能有一个主键', normalizeAccelerator('Ctrl+A+B') === null, String(normalizeAccelerator('Ctrl+A+B')))
  push('只有修饰键不算', normalizeAccelerator('Ctrl+Alt') === null, String(normalizeAccelerator('Ctrl+Alt')))
  push('加号键写成 Plus', normalizeAccelerator('Ctrl++') === 'Ctrl+Plus', String(normalizeAccelerator('Ctrl++')))
  push('具名键被认', normalizeAccelerator('Ctrl+space') === 'Ctrl+Space', String(normalizeAccelerator('Ctrl+space')))

  // 冲突：同一个键两个动作 = 恰好一对，且未绑定永远不参与。
  const conflictMap = { ...DEFAULT_HOTKEYS, overlayLock: 'Alt+Shift+O' }
  const conflicts = findHotkeyConflicts(conflictMap)
  push(
    '两处同键恰好一对冲突',
    conflicts.length === 1 &&
      conflicts[0].accelerator === 'Alt+Shift+O' &&
      conflicts[0].ids.includes('overlayToggle') &&
      conflicts[0].ids.includes('overlayLock'),
    JSON.stringify(conflicts)
  )
  const allUnbound = Object.fromEntries(HOTKEY_ACTION_IDS.map((id) => [id, ''])) as typeof DEFAULT_HOTKEYS
  push('全未绑定不算冲突', findHotkeyConflicts(allUnbound).length === 0, JSON.stringify(findHotkeyConflicts(allUnbound)))
  push(
    '未绑定与已绑定不算冲突',
    findHotkeyConflicts({ ...DEFAULT_HOTKEYS, overlayLock: '', voiceCapture: '' }).length === 0,
    'ok'
  )

  // 逐项兜底：一个键写坏不该把整张表废掉。
  const fromPartial = normalizeHotkeyMap({
    overlayToggle: 'Ctrl+Shift+F9',
    overlayLock: 42,
    overlayCollapse: 'nonsense',
    unknownAction: 'Ctrl+Q'
  })
  push('合法项被保留', fromPartial.overlayToggle === 'Ctrl+Shift+F9', fromPartial.overlayToggle)
  push('非字符串回落到该项默认', fromPartial.overlayLock === DEFAULT_HOTKEYS.overlayLock, fromPartial.overlayLock)
  push('非法值回落到该项默认', fromPartial.overlayCollapse === DEFAULT_HOTKEYS.overlayCollapse, fromPartial.overlayCollapse)
  push('未提到的动作仍是默认', fromPartial.inplaceSend === DEFAULT_HOTKEYS.inplaceSend, fromPartial.inplaceSend)
  push(
    '未知动作 id 被丢掉',
    !Object.prototype.hasOwnProperty.call(fromPartial, 'unknownAction'),
    Object.keys(fromPartial).join(',')
  )
  const fromGarbage = normalizeHotkeyMap('not-an-object')
  push(
    '整份坏值退回全默认',
    HOTKEY_ACTION_IDS.every((id) => fromGarbage[id] === DEFAULT_HOTKEYS[id]),
    JSON.stringify(fromGarbage)
  )
  push(
    '空串（未绑定）能存下来',
    normalizeHotkeyMap({ ...DEFAULT_HOTKEYS, voiceCapture: '' }).voiceCapture === '',
    'ok'
  )

  // 显示：给人看的写法要和系统写法分开，未绑定要有占位。
  push('显示写法把 Super 叫 Win', formatAccelerator('Super+O') === 'Win+O', formatAccelerator('Super+O'))
  push('显示写法保留普通键', formatAccelerator('Alt+Shift+O') === 'Alt+Shift+O', formatAccelerator('Alt+Shift+O'))
  push('未绑定有占位文案', formatAccelerator('') === UNBOUND_LABEL, formatAccelerator(''))

  // 录制器：只按修饰键不能把值填掉，否则按一下 Shift 就「录完了」。
  const pending = chordFromKeyEvent({ key: 'Shift', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false })
  push('只按修饰键不完成录制', pending.complete === false, JSON.stringify(pending))
  const bare = chordFromKeyEvent({ key: 'o', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })
  push(
    '裸字母录制后被判需要修饰键',
    bare.complete === true && bare.problem === 'need-modifier',
    JSON.stringify(bare)
  )
  const bareFn = chordFromKeyEvent({ key: 'F9', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })
  push(
    '裸功能键录制通过',
    bareFn.complete === true && bareFn.problem === null && bareFn.accelerator === 'F9',
    JSON.stringify(bareFn)
  )
  const chord = chordFromKeyEvent({ key: 'o', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false })
  push(
    '完整组合录成 canonical 写法',
    chord.complete === true && chord.accelerator === 'Alt+Shift+O' && chord.problem === null,
    JSON.stringify(chord)
  )

  // 描述表：面板一次画完所需的字段齐全，未绑定的 verdict 就是 unbound。
  const described = describeHotkeys({ ...DEFAULT_HOTKEYS, voiceCapture: '' })
  push(
    '描述表动作数一致',
    described.actions.length === HOTKEY_ACTIONS.length,
    String(described.actions.length)
  )
  push(
    '未绑定动作的 verdict 是 unbound',
    described.actions.find((item) => item.id === 'voiceCapture')?.verdict === 'unbound',
    String(described.actions.find((item) => item.id === 'voiceCapture')?.verdict)
  )

  // 只解析不注册也要能看出拆得对不对（后面真注册失败时能分清是规则错还是系统不给）。
  const parsed = parseAccelerator('Alt+Shift+O')
  push(
    '解析出两个修饰键一个主键',
    parsed?.modifiers.length === 2 && parsed.key === 'O',
    JSON.stringify(parsed)
  )

  // 按住模式靠 acceleratorVks 把组合键翻译成 GetAsyncKeyState 的 VK 码：
  // 这里只要错一位，热键就变成「按了半天没反应」，实机上极难看出是哪一步。
  push(
    '组合键拆出三个 VK（Alt+Shift+V）',
    JSON.stringify(acceleratorVks('Alt+Shift+V')) === JSON.stringify([0x12, 0x10, 0x56]),
    JSON.stringify(acceleratorVks('Alt+Shift+V'))
  )
  push(
    '修饰键别名统一到 VK（Control+Space）',
    JSON.stringify(acceleratorVks('Control+Space')) === JSON.stringify([0x11, 0x20]),
    JSON.stringify(acceleratorVks('Control+Space'))
  )
  push(
    '功能键用 VK（Shift+F1）',
    JSON.stringify(acceleratorVks('Shift+F1')) === JSON.stringify([0x10, 0x70]),
    JSON.stringify(acceleratorVks('Shift+F1'))
  )
  push('空键不拆', acceleratorVks('') === null, String(acceleratorVks('')))
  push('未知键名不拆', acceleratorVks('NotAKey') === null, String(acceleratorVks('NotAKey')))
  push('默认识别方式是按住', DEFAULT_CAPTURE_MODE === 'hold', DEFAULT_CAPTURE_MODE)
  push(
    '识别方式归一化',
    normalizeCaptureMode('toggle') === 'toggle' &&
      normalizeCaptureMode('hold') === 'hold' &&
      normalizeCaptureMode('nonsense') === 'hold' &&
      normalizeCaptureMode(undefined) === 'hold',
    'toggle/hold/乱填→hold'
  )
  push('同键冲突判定', captureKeyClash('F5', 'f5') && !captureKeyClash('F5', 'F6'), 'F5≡f5、F5≢F6')
  push('空键不算冲突', !captureKeyClash('', 'F5') && !captureKeyClash('F5', ''), '空串放行')
  push(
    '录音横幅按模式换文案',
    recordingStageLine('hold', 'Alt+Shift+V').includes('松开结束') &&
      recordingStageLine('toggle', 'Alt+Shift+V').includes('Alt+Shift+V'),
    recordingStageLine('hold', 'Alt+Shift+V')
  )
  // 真注册一轮：canonical 写法必须被平台接受，否则规则自洽而键照样抢不到。
  // 注册结果按真实系统为准，抢不到可能只是别的软件占着，所以这里只把「全失败」当失败。
  let registered = 0
  for (const action of HOTKEY_ACTIONS) {
    try {
      if (globalShortcut.register(action.defaultAccelerator, () => {})) registered += 1
    } catch {
      // 平台拒绝就计为失败，不抛。
    }
  }
  globalShortcut.unregisterAll()
  push(
    '平台至少接受一个默认键',
    registered > 0,
    `${registered}/${HOTKEY_ACTIONS.length}`
  )

  let rejectedIllegal = false
  try {
    rejectedIllegal = !globalShortcut.register('NotAKey', () => {})
  } catch {
    rejectedIllegal = true
  }
  push('平台拒绝非法组合', rejectedIllegal, String(rejectedIllegal))

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(
    `HOTKEY_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
  )
  app.exit(failed.length > 0 ? 1 : 0)
}
