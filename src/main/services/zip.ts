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
import { deflateRawSync } from 'node:zlib'

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
