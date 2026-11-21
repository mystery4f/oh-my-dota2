/**
 * 最小 ZIP 写入器（#111 诊断包用）。
 *
 * 为什么不加依赖：仓库里没有任何压缩库，`archiver`/`jszip` 之类都只是被 electron-builder 带着，
 * 拿它们的传递依赖当运行时依赖，打包一次就可能静默消失。ZIP 的 stored / deflate 两种方式
 * 用 `node:zlib` 就能写完，四十行换掉一个依赖，值。
 *
 * 只支持需要的子集：无加密、无 ZIP64（诊断包远小于 4 GB）、名字按 UTF-8 标记（flag 0x0800，
 * 这样中文文件名在 Windows 资源管理器里不会变成乱码）。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** 包内路径，用 `/` 分隔。 */
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS 时间戳：ZIP 头里只有这两段，秒按 2 秒粒度。 */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear())
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  }
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50
/** bit 11 = 文件名是 UTF-8。 */
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** 把若干条目打成 ZIP 的字节。同样内容 + 同样时间 = 同样字节，探针可以直接比。 */
export function buildZip(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
  const stamp = dosStamp(at)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data)
    const deflated = deflateRawSync(raw)
    // deflate 比原文还大就存储（小文件常见），省得包比日志还大。
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(SIG_END, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, end])
}

/**
 * 读回一个 zip：只认 `buildZip` 写得出的那个子集（stored / deflate、无加密、无 ZIP64）。
 *
 * 从中央目录读，不从本地头顺序扫：本地头里的「压缩后大小」在被流式写入时可能是 0，
 * 中央目录才是权威——诊断包与设置包都是我们自己写的，这条路永远成立。
 * 坏包一律返回 null，调用方拿一句话报错，不要在这里抛异常（半包导入必须被拒）。
 */
export function readZip(buffer: Uint8Array): Map<string, Uint8Array> | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const findEocd = (): number => {
    const minStart = Math.max(0, buffer.byteLength - 22 - 65535)
    for (let at = buffer.byteLength - 22; at >= minStart; at -= 1) {
      if (view.getUint32(at, true) === 0x06054b50) return at
    }
    return -1
  }
  const eocd = findEocd()
  if (eocd < 0) return null
  const total = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const files = new Map<string, Uint8Array>()
  const decoder = new TextDecoder('utf-8')
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.byteLength || view.getUint32(cursor, true) !== 0x02014b50) return null
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    if (localOffset + 30 > buffer.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) return null
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (raw.byteLength !== compressedSize) return null
    if (method === 0) {
      files.set(name, raw)
    } else if (method === 8) {
      try {
        files.set(name, new Uint8Array(inflateRawSync(raw)))
      } catch {
        return null
      }
    } else {
      return null
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}
