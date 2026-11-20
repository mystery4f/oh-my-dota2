/**
 * 诊断包探针（#111）：不碰网络、不读真实数据目录，全程在临时目录里。
 *
 * 锁三条：
 * - 脱敏真的换了字：昵称按首次出现编号（同一名同一个号），设备 id 变占位，label 不动；
 * - 归档真的含 manifest 与每一份在场文件，缺的文件进 manifest.missing 而不是消失；
 * - 同内容 + 同时间 → 同字节（包是可比的），关掉脱敏时原文保留且 manifest 说没脱敏。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  DEVICE_ID_PLACEHOLDER,
  LOG_BUNDLE_FILES,
  maskLogText,
  wantedLogFiles,
  type LogBundleManifest
} from '@shared/log-bundle'
import { exportLogBundle } from '../services/log-bundle'
import { buildZip } from '../services/zip'
import { finishProbe, probeCases } from './harness'

/** 探针里的 ZIP 读回：只读 central directory，够证明「包里有这些东西」。 */
function readZip(data: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  // EOCD 从尾部往前找（注释长度理论上可变，我们没有注释，直接找签名即可）。
  let eocd = -1
  for (let i = data.length - 22; i >= 0; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('没有 EOCD：这不是一个 zip')
  const count = data.readUInt16LE(eocd + 10)
  let cursor = data.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`central #${i} 签名不对`)
    const method = data.readUInt16LE(cursor + 10)
    const compSize = data.readUInt32LE(cursor + 20)
    const nameLen = data.readUInt16LE(cursor + 28)
    const extraLen = data.readUInt16LE(cursor + 30)
    const commentLen = data.readUInt16LE(cursor + 32)
    const localOffset = data.readUInt32LE(cursor + 42)
    const name = data.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    const localNameLen = data.readUInt16LE(localOffset + 26)
    const localExtraLen = data.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const body = data.subarray(start, start + compSize)
    out.set(name, method === 8 ? inflateRawSync(body) : body)
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const CHAT = [
  '{"at":"2026-11-21T00:00:00.000Z","slot":1,"name":"小明","text":"nice smoke"}',
  '{"at":"2026-11-21T00:00:01.000Z","slot":2,"name":"红红","text":"gg"}',
  '{"at":"2026-11-21T00:00:02.000Z","slot":1,"name":"小明","text":"再来一把"}'
].join('\n')
const VOICE = '{"at":"2026-11-21T00:00:00.000Z","mic":"麦克风 (Realtek)|a1b2c3d4","totalMs":812}\n'

export async function runLogBundleProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const root = mkdtempSync(join(tmpdir(), 'omd2-log-bundle-'))
  const logs = join(root, 'logs')

  try {
    // —— 纯缝：脱敏 ——
    const masked = maskLogText(CHAT, true)
    push(
      '昵称按首次出现编号，同名同号，原文不再出现',
      masked.masked &&
        masked.text.includes('"name":"玩家1"') &&
        masked.text.includes('"name":"玩家2"') &&
        !masked.text.includes('小明') &&
        !masked.text.includes('红红') &&
        (masked.text.match(/玩家1/g) ?? []).length === 2,
      masked.text.split('\n')[0]
    )
    const voiceMasked = maskLogText(VOICE, true)
    push(
      '设备 id 变占位，设备名留着（它就是「哪个麦」的证据）',
      voiceMasked.masked &&
        voiceMasked.text.includes(`麦克风 (Realtek)|${DEVICE_ID_PLACEHOLDER}`) &&
        !voiceMasked.text.includes('a1b2c3d4') &&
        voiceMasked.text.includes('"totalMs":812'),
      voiceMasked.text
    )
    const plain = maskLogText('{"act":"idle","grabMs":18}\n', true)
    push('没有身份字段的那份不算脱敏（manifest 说没换就是没换）', !plain.masked && plain.text.includes('"grabMs":18'), `masked=${plain.masked}`)
    const off = maskLogText(CHAT, false)
    push('显式关掉脱敏时原文保留', !off.masked && off.text === CHAT, `len=${off.text.length}`)
    push(
      '只收表里点名的文件，且按表里顺序',
      wantedLogFiles(['voice-chain.jsonl', 'not-a-log.txt', 'gsi-chat.jsonl']).map((f) => f.name).join(',') ===
        'gsi-chat.jsonl,voice-chain.jsonl',
      wantedLogFiles(['voice-chain.jsonl', 'not-a-log.txt', 'gsi-chat.jsonl']).map((f) => f.name).join(',')
    )

    // —— 归档：在场 / 缺失 / manifest ——
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'gsi-chat.jsonl'), CHAT, 'utf8')
    writeFileSync(join(logs, 'voice-chain.jsonl'), VOICE, 'utf8')
    writeFileSync(join(logs, 'inplace.log'), '2026-11-21 00:00:00 [stage] grab ok\n', 'utf8')

    const at = new Date('2026-11-21T04:15:00')
    const result = await exportLogBundle({ logsDir: logs, version: '9.9.9', buildStamp: 'STAMP-1', now: at })
    push('导出成功并给出包路径', result.ok && result.path !== null && result.path.endsWith('.zip'), `${result.path} ${result.bytes} B`)

    const entries = readZip(readFileSync(result.path ?? ''))
    const names = [...entries.keys()]
    push(
      '归档里有 manifest 与每一份在场文件',
      names.length === 4 &&
        names.includes('manifest.json') &&
        names.includes('gsi-chat.jsonl') &&
        names.includes('voice-chain.jsonl') &&
        names.includes('inplace.log'),
      names.join(',')
    )
    push(
      '包里的日志已脱敏（原文不在包里）',
      !entries.get('gsi-chat.jsonl')?.toString('utf8').includes('小明') &&
        entries.get('gsi-chat.jsonl')?.toString('utf8').includes('玩家1') === true,
      entries.get('gsi-chat.jsonl')?.toString('utf8').split('\n')[0]
    )

    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? '{}') as LogBundleManifest
    push(
      'manifest 带版本、构建戳与平台',
      manifest.app === 'oh-my-dota2' && manifest.version === '9.9.9' && manifest.buildStamp === 'STAMP-1' && manifest.platform.length > 0,
      `${manifest.version} | ${manifest.buildStamp} | ${manifest.platform}`
    )
    push(
      'manifest 列出在场文件与原字节数',
      manifest.files.length === 3 &&
        manifest.files.find((f) => f.name === 'gsi-chat.jsonl')?.masked === true &&
        manifest.files.find((f) => f.name === 'voice-chain.jsonl')?.masked === true &&
        // 没有身份字段的那份（inplace.log）如实说没脱敏，不冒充。
        manifest.files.find((f) => f.name === 'inplace.log')?.masked === false &&
        manifest.files.find((f) => f.name === 'gsi-chat.jsonl')?.bytes === Buffer.byteLength(CHAT) &&
        manifest.files.filter((f) => f.masked).length === 2,
      manifest.files.map((f) => `${f.name}:${f.bytes}`).join(' ')
    )
    push(
      '缺失的文件被列出，不静默跳过',
      manifest.missing.length === LOG_BUNDLE_FILES.length - 3 &&
        manifest.missing.includes('gsi-summary.json') &&
        manifest.missing.includes('capture-ticks.jsonl') &&
        !names.includes('gsi-summary.json'),
      manifest.missing.join(',')
    )
    push(
      '导出结果把缺的文件也交给面板',
      result.missing.length === manifest.missing.length && result.files === 3,
      `${result.files} 份 · 缺 ${result.missing.length}`
    )

    // —— 不脱敏 + 同内容同时间同字节 ——
    const raw = await exportLogBundle({ logsDir: logs, version: '9.9.9', buildStamp: 'STAMP-1', mask: false, now: at })
    const rawManifest = JSON.parse(
      readZip(readFileSync(raw.path ?? '')).get('manifest.json')?.toString('utf8') ?? '{}'
    ) as LogBundleManifest
    push(
      '关掉脱敏：原文进包，manifest 说没脱敏',
      raw.ok &&
        readZip(readFileSync(raw.path ?? '')).get('gsi-chat.jsonl')?.toString('utf8') === CHAT &&
        rawManifest.files.every((f) => !f.masked),
      `masked=${rawManifest.files.map((f) => f.masked).join(',')}`
    )
    const one = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }], at)
    const two = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }], at)
    push('同内容同时间 → 同字节（包可比）', one.equals(two), `${one.length} B`)
  } catch (error) {
    push('探针本身不能抛', false, error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  finishProbe('LOG_BUNDLE_PROBE', cases)
}
