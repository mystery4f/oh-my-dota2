/**
 * 数据体检探针（#104）：全程在临时目录里造 wav，一个字节都不读真实录音目录。
 *
 * 锁三条：
 * - 「重复 + 静音 + 缺句」的目录正好报这三类，不多不少（这是票面的验收线）；
 * - 干净目录一条都不报，时长分布算得对（最短/中位/最长/合计）；
 * - 「录不出话」和面板用的对讲判定是同一组阈值：全零是 silent，200 毫秒是 too-short，读不懂的文件也报。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEALTH_KEYS_SHOWN, healthLine, judgeDatasetHealth, type HealthTakeInput } from '@shared/train/dataset-health'
import { WAV_BYTES_PER_SAMPLE, WAV_HEADER_BYTES, WAV_SAMPLE_RATE } from '@shared/wav'
import { datasetHealthOf } from '../services/train/ft-health'
import { readWavFacts } from '../services/train/wav-facts'
import { finishProbe, probeCases } from './harness'

/** 造一条 PCM16 单声道 16 kHz 的 wav：amplitude=0 就是全零（判静音用）。 */
function writeWav(path: string, ms: number, amplitude: number): void {
  const frames = Math.round((WAV_SAMPLE_RATE * ms) / 1000)
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + frames * WAV_BYTES_PER_SAMPLE)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(WAV_SAMPLE_RATE, 24)
  buffer.writeUInt32LE(WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE, 28)
  buffer.writeUInt16LE(WAV_BYTES_PER_SAMPLE, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * WAV_BYTES_PER_SAMPLE, 40)
  for (let index = 0; index < frames; index += 1) {
    const value = amplitude === 0 ? 0 : Math.sin((index / WAV_SAMPLE_RATE) * 2 * Math.PI * 220) * amplitude
    buffer.writeInt16LE(Math.max(-1, Math.min(1, value)) * 0x7fff, WAV_HEADER_BYTES + index * WAV_BYTES_PER_SAMPLE)
  }
  writeFileSync(path, buffer)
}

function take(root: string, key: string, text: string, ms: number, amplitude: number): HealthTakeInput & { wavPath: string } {
  const wavPath = join(root, `${key}.wav`)
  writeWav(wavPath, ms, amplitude)
  return { key, text, wavPath, ...readWavFacts(wavPath) }
}

export async function runDatasetHealthProbe(): Promise<void> {
  const { cases, push: check } = probeCases()
  const root = mkdtempSync(join(tmpdir(), 'ft-health-'))
  try {
    // 脏目录：一句重复、一条全零、一句稿子里有但没录。
    const dirty = join(root, 'dirty')
    mkdirSync(dirty)
    const dirtyTakes = [
      take(dirty, 'G01-L01', '中路 miss', 800, 0.4),
      take(dirty, 'G01-L02', '中路 miss', 800, 0.4),
      take(dirty, 'G01-L03', '撤退', 800, 0),
      take(dirty, 'G01-L05', '好', 200, 0.4)
    ]
    const dirtyHealth = datasetHealthOf({
      takes: dirtyTakes.map(({ wavPath, ...rest }) => ({ key: rest.key, text: rest.text, wavPath })),
      expected: ['G01-L01', 'G01-L02', 'G01-L03', 'G01-L04', 'G01-L05']
    })
    const kinds = dirtyHealth.issues.map((issue) => issue.kind)
    check(
      '脏目录正好报三类：重复、录不出话、缺句',
      dirtyHealth.issues.length === 3 && kinds.join(',') === 'duplicate,unusable,missing',
      kinds.join(',')
    )
    const duplicate = dirtyHealth.issues.find((issue) => issue.kind === 'duplicate')
    check(
      '重复点名到那两条 key（不是只说「有重复」）',
      duplicate?.keys.join(',') === 'G01-L01,G01-L02' && duplicate?.label.includes('1 句文本重复'),
      `${duplicate?.keys.join(',')} · ${duplicate?.label}`
    )
    const unusable = dirtyHealth.issues.find((issue) => issue.kind === 'unusable')
    check(
      '录不出话按理由分类：没有声音 1、太短 1',
      unusable?.label.includes('没有声音 1') === true && unusable?.label.includes('太短 1') === true,
      unusable?.label ?? ''
    )
    const missing = dirtyHealth.issues.find((issue) => issue.kind === 'missing')
    check('缺句只点名稿子里没录的那句', missing?.keys.join(',') === 'G01-L04', missing?.keys.join(',') ?? '')
    check(
      '时长分布：最短 200、最长 800、合计 2600',
      dirtyHealth.duration.minMs === 200 && dirtyHealth.duration.maxMs === 800 && dirtyHealth.duration.totalMs === 2600,
      JSON.stringify(dirtyHealth.duration)
    )
    check('有问题就不是 ok', !dirtyHealth.ok && dirtyHealth.takes === 4, `takes=${dirtyHealth.takes}`)

    // 干净目录：两条都在、都有声音、稿子全录到。
    const clean = join(root, 'clean')
    mkdirSync(clean)
    const cleanTakes = [take(clean, 'G01-L01', '中路 miss', 800, 0.4), take(clean, 'G01-L02', '撤退', 1000, 0.3)]
    const cleanHealth = datasetHealthOf({
      takes: cleanTakes.map(({ wavPath, ...rest }) => ({ key: rest.key, text: rest.text, wavPath })),
      expected: ['G01-L01', 'G01-L02']
    })
    check(
      '干净目录一条都不报',
      cleanHealth.ok && cleanHealth.issues.length === 0 && cleanHealth.takes === 2,
      JSON.stringify(cleanHealth.issues)
    )
    check(
      '干净目录的时长：中位 900、合计 1800',
      cleanHealth.duration.medianMs === 900 && cleanHealth.duration.totalMs === 1800,
      JSON.stringify(cleanHealth.duration)
    )
    check('干净目录那一行说清楚条目与秒数', healthLine(cleanHealth) === '2 条 · 共 1.8 秒 · 没有重复/静音/缺句', healthLine(cleanHealth))

    // 读不懂的文件：不是静默跳过，而是报「录不出话」。
    const brokenPath = join(root, 'broken.wav')
    writeFileSync(brokenPath, 'not a riff at all')
    const broken = datasetHealthOf({
      takes: [{ key: 'G01-L09', text: '看不懂', wavPath: brokenPath }],
      expected: ['G01-L09']
    })
    check(
      '非 wav 文件报「录不出话」而不是被跳过',
      broken.issues.length === 1 && broken.issues[0].kind === 'unusable',
      broken.issues.map((issue) => issue.kind).join(',')
    )

    // 没有录音、也没有稿子：空体检，不是「缺句 40 条」。
    const empty = judgeDatasetHealth({ takes: [], expected: [] })
    check('没有录音也没有稿子：空体检不报警', empty.ok && empty.takes === 0, JSON.stringify(empty.issues))

    // 点名有上限：20 句没录也只列前 HEALTH_KEYS_SHOWN 条，计数照旧是 20。
    const many = judgeDatasetHealth({
      takes: [],
      expected: Array.from({ length: 20 }, (_, index) => `G09-L${String(index + 1).padStart(2, '0')}`)
    })
    check(
      `缺句点名不超过 ${HEALTH_KEYS_SHOWN} 条，但计数是准的`,
      many.issues[0].keys.length === HEALTH_KEYS_SHOWN && many.issues[0].label.includes('20 句'),
      `${many.issues[0].keys.length} · ${many.issues[0].label}`
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  finishProbe('DATASET_HEALTH_PROBE', cases)
}
