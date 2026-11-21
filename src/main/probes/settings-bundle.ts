/**
 * 设置包探针（#81）：不碰用户真实设置、不联网。
 *
 * 锁三条验收线：
 * - 导出再导入，每一项设置都回来（用一份造出来的设置做往返，不读磁盘上那份）；
 * - 包里没有密钥：把 zip 字节整段搜一遍，找到假 key 就算红；
 * - 半包被拒：缺文件、坏 zip、版本不符都只回一句话，`apply` 一次都不许被调用。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings-shape'
import {
  SETTINGS_BUNDLE_MANIFEST,
  SETTINGS_BUNDLE_SETTINGS,
  SETTINGS_BUNDLE_VERSION,
  judgeSettingsBundle,
  keepLocalSecrets,
  settingsBundleLine,
  settingsExportLine,
  settingsImportLine,
  stripSecrets
} from '@shared/settings-bundle'
import { exportSettingsBundle, importSettingsBundle } from '../services/settings-bundle'
import { buildZip } from '../services/zip'
import { finishProbe, probeCases } from './harness'

const SECRET_KEY = 'PROBE-FAKE-KEY-0123456789'
const SECRET_PROXY = 'http://user:pass@127.0.0.1:4444'

function fakeSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    provider: { ...DEFAULT_SETTINGS.provider, apiKey: SECRET_KEY },
    providerKeys: { deepseek: SECRET_KEY },
    proxyUrl: SECRET_PROXY,
    targetLang: 'zh',
    replyTone: 'casual',
    ...patch
  } as AppSettings
}

export async function runSettingsBundleProbe(): Promise<void> {
  const { cases, push: check } = probeCases()
  const dir = mkdtempSync(join(tmpdir(), 'omd-bundle-'))
  try {
    // —— 导出：文件在、条目齐、密钥被抹
    const settings = fakeSettings()
    const exported = exportSettingsBundle({ dir, settings, at: new Date('2026-01-02T03:04:05Z'), trainIndex: () => [] })
    check('导出成功并写出一个 zip', exported.ok && exported.path !== null, exported.path ?? exported.error ?? '')
    check('导出记了三份文件', exported.files === 3, String(exported.files))
    const bytes = exported.path === null ? Buffer.alloc(0) : readFileSync(exported.path)
    const haystack = bytes.toString('latin1')
    check('包里搜不到 API key', !haystack.includes(SECRET_KEY))
    check('包里搜不到代理账号密码', !haystack.includes('user:pass'))
    check('被抹的字段记进了 omitted', exported.omitted.length === 3, exported.omitted.join('、'))
    const stripped = stripSecrets(settings)
    check('剥密钥后仍是完整设置对象', stripped.exported.provider.apiKey === '' && stripped.exported.providerKeys !== undefined)
    check('剥密钥不动非密钥字段', stripped.exported.targetLang === settings.targetLang)

    // —— 导入：往返一致，密钥保持本机
    let appliedPatch: Partial<AppSettings> | null = null
    const imported = importSettingsBundle(exported.path ?? '', {
      current: settings,
      apply: (patch) => {
        appliedPatch = patch
      }
    })
    check('导入成功', imported.ok, imported.error ?? '')
    check('导入时 apply 被调用一次', appliedPatch !== null)
    const restored = appliedPatch as Partial<AppSettings> | null
    check('往返后关键设置一致', restored !== null && restored.targetLang === settings.targetLang && restored.replyTone === settings.replyTone)
    check('本机 API key 没被清空', restored !== null && restored.provider?.apiKey === SECRET_KEY)
    check('本机代理地址没被清空', restored !== null && restored.proxyUrl === SECRET_PROXY)
    check('报出保留了哪几项', imported.kept.length === 3, imported.kept.join('、'))

    // —— 干净机器上导出（没有密钥）时 kept 为空
    const bare = keepLocalSecrets(stripSecrets(fakeSettings()).exported, fakeSettings({ provider: { ...DEFAULT_SETTINGS.provider, apiKey: '' }, providerKeys: {}, proxyUrl: '' }))
    check('干净机器上不说「保留本机」', bare.kept.length === 0)

    // —— 半包一律拒绝，且一次都不落盘
    const partialPath = join(dir, 'partial.zip')
    writeFileSync(
      partialPath,
      buildZip([{ name: SETTINGS_BUNDLE_MANIFEST, data: Buffer.from(JSON.stringify({ app: 'x', version: SETTINGS_BUNDLE_VERSION, createdAt: '', omitted: [] })) }])
    )
    let partialApplied = 0
    const partial = importSettingsBundle(partialPath, { current: settings, apply: () => (partialApplied += 1) })
    check('缺 settings.json 的包被拒', !partial.ok && partial.error?.includes('settings.json') === true, partial.error ?? '')
    check('被拒的包一个字段都没写', partialApplied === 0)

    const corruptPath = join(dir, 'corrupt.zip')
    writeFileSync(corruptPath, Buffer.from('this is not a zip at all'))
    const corrupt = importSettingsBundle(corruptPath, { current: settings, apply: () => (partialApplied += 1) })
    check('坏 zip 被拒且说明读不了', !corrupt.ok && corrupt.error !== null, corrupt.error ?? '')
    check('坏 zip 也没落盘', partialApplied === 0)

    const futurePath = join(dir, 'future.zip')
    writeFileSync(
      futurePath,
      buildZip([
        { name: SETTINGS_BUNDLE_MANIFEST, data: Buffer.from(JSON.stringify({ app: 'x', version: 99, createdAt: '', omitted: [] })) },
        { name: SETTINGS_BUNDLE_SETTINGS, data: Buffer.from(JSON.stringify(fakeSettings())) }
      ])
    )
    const future = importSettingsBundle(futurePath, { current: settings, apply: () => (partialApplied += 1) })
    check('未来版本的包被拒并说清版本', !future.ok && future.error?.includes('v99') === true, future.error ?? '')
    check('版本不符也没落盘', partialApplied === 0)

    // —— 纯判定：三个拒绝理由各说各的
    check('缺 manifest 的理由点名 manifest', judgeSettingsBundle([{ name: SETTINGS_BUNDLE_SETTINGS, bytes: 10 }]).reason?.includes('manifest.json') === true)
    check('空文件的理由点名文件', judgeSettingsBundle([{ name: SETTINGS_BUNDLE_MANIFEST, bytes: 0 }, { name: SETTINGS_BUNDLE_SETTINGS, bytes: 5 }]).reason?.includes('空的') === true)
    check('版本不同的理由带两个版本号', judgeSettingsBundle([{ name: SETTINGS_BUNDLE_MANIFEST, bytes: 1 }, { name: SETTINGS_BUNDLE_SETTINGS, bytes: 1 }], 7).reason?.includes('v7') === true)

    // —— 给人看的两行
    check('导出的那一行带文件和省略项', settingsExportLine(exported).includes('3 份文件') && settingsExportLine(exported).includes('不带'))
    check('导入的那一行带项数与保留项', settingsImportLine(imported).includes('已导入') && settingsImportLine(imported).includes('保留本机'))
    check('拒绝那一行说「拒绝导入」', settingsImportLine(partial).includes('拒绝导入'))
    check('settingsBundleLine 空包也能说', settingsBundleLine({ files: 0, omitted: [] }) === '空包')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  finishProbe('SETTINGS_BUNDLE_PROBE', cases)
}
