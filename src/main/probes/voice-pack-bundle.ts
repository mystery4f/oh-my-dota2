/**
 * #89 音色包单文件的探针。
 *
 * 票面验收：`Import refuses a pack whose reference audio or prompt text is missing, and names which part failed.`
 * 这里用临时目录与 `buildZip` 真造包：导出 → 导入闭环一遍，然后四种残缺包逐一断言拒收且**指名到件**、
 * **一个字节都没落盘**（`apply` 没被调用）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildZip } from '../services/zip'
import { exportVoicePackBundle, importVoicePackBundle } from '../services/voice/voice-pack-bundle'
import {
  VOICE_PACK_BUNDLE_VERSION,
  VOICE_PACK_MANIFEST_FILE,
  judgeVoicePackBundle,
  voicePackBundleEntries,
  voicePackCheckLine,
  type VoicePackBundleManifest
} from '@shared/voice-pack-bundle'
import { sovitsRefsFile, sovitsRefsRoot, sovitsWeightsRoot } from '../services/voice/sovits-refs'
import { finishProbe, probeCases } from './harness'

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64), Buffer.from('data')])

function seedUserData(root: string, id = 'mina'): void {
  const refsRoot = sovitsRefsRoot(root)
  const weightsRoot = sovitsWeightsRoot(root)
  mkdirSync(join(refsRoot, id), { recursive: true })
  mkdirSync(join(weightsRoot, id), { recursive: true })
  writeFileSync(join(refsRoot, id, 'ref.wav'), WAV)
  writeFileSync(join(weightsRoot, id, 'mina-e15.ckpt'), Buffer.from('gpt'))
  writeFileSync(join(weightsRoot, id, 'mina_e15.pth'), Buffer.from('sovits'))
  writeFileSync(
    sovitsRefsFile(refsRoot),
    JSON.stringify([
      {
        name: '米拉娜',
        audio: `${id}/ref.wav`,
        promptText: '这是一句参考文本。',
        promptLang: 'zh',
        gptWeights: `${id}/mina-e15.ckpt`,
        sovitsWeights: `${id}/mina_e15.pth`
      }
    ]),
    'utf8'
  )
}

function zipOf(entries: Array<{ name: string; data: Buffer }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vp-pack-'))
  const path = join(dir, 'pack.zip')
  writeFileSync(path, buildZip(entries, new Date('2026-01-01T00:00:00Z')))
  return path
}

export async function runVoicePackBundleProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const source = mkdtempSync(join(tmpdir(), 'vp-src-'))
  const target = mkdtempSync(join(tmpdir(), 'vp-dst-'))
  seedUserData(source)

  // —— 导出：一个文件，带清单与三件实体 ——
  const exported = exportVoicePackBundle({ id: 'mina', userDataDir: source })
  push('导出成功并给出一个文件路径', exported.ok && (exported.path ?? '').endsWith('voicepack-mina.zip'), exported.error ?? '')
  push('包里是清单 + 参考音频 + 两份权重', exported.files.length === 4 && exported.files.includes(VOICE_PACK_MANIFEST_FILE), exported.files.join(','))

  // —— 导入：落到另一份数据根，refs.json 里就有了这一条 ——
  const imported = importVoicePackBundle({ zipPath: exported.path ?? '', userDataDir: target })
  push('导出再导入：成功且音色 id 一致', imported.ok && imported.id === 'mina', imported.line)
  const refsAfter = JSON.parse(readFileSync(sovitsRefsFile(sovitsRefsRoot(target)), 'utf8')) as Array<Record<string, unknown>>
  push('导入后 refs.json 里有一条，参考文本跟着走', refsAfter.length === 1 && refsAfter[0].promptText === '这是一句参考文本。')
  push(
    '导入后三件文件真的在盘上',
    existsSync(join(sovitsRefsRoot(target), 'mina', 'ref.wav')) &&
      existsSync(join(sovitsWeightsRoot(target), 'mina', 'mina-e15.ckpt')) &&
      existsSync(join(sovitsWeightsRoot(target), 'mina', 'mina_e15.pth'))
  )

  // —— 拒绝的四种残包：指名到件，且没写任何东西 ——
  const baseManifest = {
    version: VOICE_PACK_BUNDLE_VERSION,
    id: 'mina',
    name: '米拉娜',
    promptText: '这是一句参考文本。',
    promptLang: 'zh',
    refAudio: 'ref.wav',
    gptWeights: 'mina-e15.ckpt',
    sovitsWeights: 'mina_e15.pth'
  }
  const withManifest = (patch: Record<string, unknown>, drop: string[] = []): string => {
    const manifest = { ...baseManifest, ...patch }
    const entries = [
      { name: VOICE_PACK_MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
      { name: 'ref.wav', data: WAV },
      { name: 'mina-e15.ckpt', data: Buffer.from('gpt') },
      { name: 'mina_e15.pth', data: Buffer.from('sovits') }
    ].filter((entry) => !drop.includes(entry.name))
    return zipOf(entries)
  }

  let applied = 0
  const apply = (): void => {
    applied += 1
  }

  const missingAudio = importVoicePackBundle({
    zipPath: withManifest({}, ['ref.wav']),
    userDataDir: mkdtempSync(join(tmpdir(), 'vp-bad-')),
    apply
  })
  push(
    '缺参考音频：拒收并指名「参考音频」',
    !missingAudio.ok && missingAudio.errors.some((item) => item.part === 'refAudio') && (missingAudio.line ?? '').includes('参考音频'),
    missingAudio.line
  )

  const emptyPrompt = importVoicePackBundle({
    zipPath: withManifest({ promptText: '   ' }),
    userDataDir: mkdtempSync(join(tmpdir(), 'vp-bad-')),
    apply
  })
  push(
    '缺参考文本：拒收并指名「参考文本」',
    !emptyPrompt.ok && emptyPrompt.errors.some((item) => item.part === 'promptText') && (emptyPrompt.line ?? '').includes('参考文本'),
    emptyPrompt.line
  )

  const noManifest = importVoicePackBundle({
    zipPath: zipOf([{ name: 'ref.wav', data: WAV }]),
    userDataDir: mkdtempSync(join(tmpdir(), 'vp-bad-')),
    apply
  })
  push('没有清单：拒收并说清单', !noManifest.ok && noManifest.errors[0].part === 'manifest', noManifest.line)

  const wrongVersion = importVoicePackBundle({
    zipPath: withManifest({ version: 99 }),
    userDataDir: mkdtempSync(join(tmpdir(), 'vp-bad-')),
    apply
  })
  push('版本不认识：拒收并报出两边版本', !wrongVersion.ok && wrongVersion.errors[0].detail.includes('99'), wrongVersion.line)

  const notZip = join(mkdtempSync(join(tmpdir(), 'vp-bad-')), 'broken.zip')
  writeFileSync(notZip, Buffer.from('this is not a zip'))
  const broken = importVoicePackBundle({ zipPath: notZip, userDataDir: mkdtempSync(join(tmpdir(), 'vp-bad-')), apply })
  push('文件本身不是 zip：拒收而不是崩', !broken.ok && broken.errors[0].part === 'manifest', broken.line)

  push('全部拒收路径一次都没有落盘（apply 没被调用）', applied === 0, String(applied))

  // —— 纯层：清单驱动的条目顺序与一句话 ——
  push(
    '纯层：清单各件按固定顺序取文件',
    voicePackBundleEntries(baseManifest as VoicePackBundleManifest)
      .map((item) => item.part)
      .join(',') === 'refAudio,gptWeights,sovitsWeights'
  )
  const okCheck = judgeVoicePackBundle({ manifest: baseManifest, names: ['ref.wav', 'mina-e15.ckpt', 'mina_e15.pth'] })
  push('纯层：完整的包判 ok', okCheck.ok && voicePackCheckLine(okCheck).includes('完整'))
  const wavCheck = judgeVoicePackBundle({ manifest: { ...baseManifest, refAudio: 'ref.mp3' }, names: ['ref.mp3', 'mina-e15.ckpt', 'mina_e15.pth'] })
  push('纯层：参考音频不是 wav 也要拒', !wavCheck.ok && wavCheck.errors.some((item) => item.part === 'refAudio'))

  finishProbe('VOICE_PACK_BUNDLE_PROBE', cases)
}