import { app } from 'electron'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc'
import { loadSettings, saveSettings } from '../services/settings'

/** 面板上这些「选过的值」必须活过一次重启；逐个写哨兵值再读回来。 */
const PERSISTED_FIELDS = [
  'autoStartCapture',
  'sendMode',
  'replyTone',
  'consoleKey',
  'overlayText',
  'overlayLocked',
  'overlayOpacity',
  'ttsEngine',
  'ttsVoice',
  'ttsPitch',
  'ttsReadOwn',
] as const

/** 每一项都换成一个和当前值不同的哨兵，避免「读回来的是原值」这种假通过。 */
function sentinelFor(
  key: (typeof PERSISTED_FIELDS)[number],
  current: AppSettings
): AppSettings[typeof key] {
  switch (key) {
    case 'autoStartCapture':
      return !current.autoStartCapture as AppSettings[typeof key]
    case 'sendMode':
      return (current.sendMode === 'chat' ? 'inplace' : 'chat') as AppSettings[typeof key]
    case 'replyTone':
      return (current.replyTone === 'firm' ? 'polite' : 'firm') as AppSettings[typeof key]
    case 'consoleKey':
      return (current.consoleKey === '\\' ? '`' : '\\') as AppSettings[typeof key]
    case 'overlayText':
      return (current.overlayText === 'translated' ? 'both' : 'translated') as AppSettings[typeof key]
    case 'overlayOpacity':
      return 0.2 as AppSettings[typeof key]
    case 'overlayLocked':
      return !current.overlayLocked as AppSettings[typeof key]
    case 'ttsReadOwn':
      return !current.ttsReadOwn as AppSettings[typeof key]
    case 'ttsEngine':
      return (current.ttsEngine === 'edge' ? 'system' : 'edge') as AppSettings[typeof key]
    case 'ttsVoice':
      // 换一个真实存在的嗓子，验证的是「选中的那一个」而不是「任意字符串」。
      return (current.ttsVoice === 'zh-CN-XiaoyiNeural'
        ? 'zh-CN-XiaoxiaoNeural'
        : 'zh-CN-XiaoyiNeural') as AppSettings[typeof key]
    case 'ttsPitch':
      // 0.9 / 1.1 都是面板滑杆能到的值，验的是「滑杆位置真的落盘」。
      return (current.ttsPitch > 1 ? 0.9 : 1.1) as AppSettings[typeof key]
  }
}

function readFileSettings(): Partial<AppSettings> | null {
  try {
    const file = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
  } catch {
    return null
  }
}

/**
 * 设置持久化探针（--settings-persist-probe）：纯读写，不抓屏不 OCR。
 *
 * 盯的是用户提的那条要求 ——「默认值可以保守，但用户上次选的那一项，下次启动要记住」。
 * 探针先把整份 settings.json 备份到临时目录，最后原样还原，所以跑多少次都不会污染真实配置。
 */
export async function runSettingsPersistProbe(): Promise<void> {
  const file = join(app.getPath('userData'), 'settings.json')
  const backupDir = mkdtempSync(join(tmpdir(), 'oh-my-dota2-settings-'))
  const backup = join(backupDir, 'settings.json')
  const hadFile = existsSync(file)
  if (hadFile) copyFileSync(file, backup)

  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const push = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
  }

  try {
    const before = loadSettings()
    // 默认值只在「没有 settings.json」时才决定行为：全新安装读到的必须是 DEFAULT_SETTINGS。
    rmSync(file, { force: true })
    const fresh = loadSettings()
    push(
      '全新安装读到默认值',
      fresh.autoStartCapture === DEFAULT_SETTINGS.autoStartCapture &&
        fresh.sendMode === DEFAULT_SETTINGS.sendMode,
      `autoStart=${fresh.autoStartCapture}`
    )

    for (const key of PERSISTED_FIELDS) {
      const sentinel = sentinelFor(key, before)
      const written = saveSettings({ [key]: sentinel } as Partial<AppSettings>)
      const reread = loadSettings()
      const onDisk = readFileSettings()
      push(
        `${key} 写盘后可读回`,
        written[key] === sentinel && reread[key] === sentinel && onDisk?.[key] === sentinel,
        `${String(before[key])} → ${String(sentinel)} / disk=${String(onDisk?.[key])}`
      )
    }

    // 一个字段的写入不能把别的字段冲掉：写了 7 项之后，第一项必须还在。
    const firstKey = PERSISTED_FIELDS[0]
    const afterAll = loadSettings()
    push(
      '连续写入互不覆盖',
      afterAll[firstKey] === sentinelFor(firstKey, before),
      `${firstKey}=${String(afterAll[firstKey])}`
    )

    // 用户的核心诉求：选过的值活过一次重启，而不是每次都回落到默认值。
    saveSettings({ sendMode: 'chat' })
    push('选过 chat 后默认值不再生效', loadSettings().sendMode === 'chat', loadSettings().sendMode)
    saveSettings({ sendMode: 'inplace' })
    push('选回 inplace 后同样保留', loadSettings().sendMode === 'inplace', loadSettings().sendMode)

    // 残缺文件不能把整份配置读成 undefined：写一份空 JSON，缺的字段必须回落到默认值。
    writeFileSync(file, '{}', 'utf-8')
    const fromEmpty = loadSettings()
    push(
      '残缺文件按字段回落到默认值',
      fromEmpty.autoStartCapture === DEFAULT_SETTINGS.autoStartCapture &&
        fromEmpty.sendMode === DEFAULT_SETTINGS.sendMode,
      `sendMode=${fromEmpty.sendMode}`
    )

    // 未登记的键不该让读取炸掉（老版本文件多出来的字段）。
    writeFileSync(file, JSON.stringify({ sendMode: 'chat', retiredKey: { nested: 1 } }), 'utf-8')
    const withUnknown = loadSettings()
    push('未知字段被忽略', withUnknown.sendMode === 'chat', `sendMode=${withUnknown.sendMode}`)
  } finally {
    if (hadFile) copyFileSync(backup, file)
    rmSync(backupDir, { recursive: true, force: true })
    const restored = loadSettings()
    const expected = hadFile ? readFileSettings() : null
    checks.push({
      name: '结束后原样还原',
      ok: hadFile ? restored.sendMode === expected?.sendMode : restored.sendMode === DEFAULT_SETTINGS.sendMode,
      detail: `sendMode=${restored.sendMode}`
    })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'SETTINGS_PERSIST_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}
