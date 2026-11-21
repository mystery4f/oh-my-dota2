/**
 * 词表包装卸（#82）：把数据目录 glossary/ 下的一份 JSON 换成现役对照表。
 *
 * 三条规矩：
 * - 装不上就回退内置，绝不换成空表 —— 翻译失去术语保护比用旧词表更糟。
 * - 失败原因留在 status 里给面板看，不静默吞掉。
 * - 选择写回设置（glossaryPackName），重启后还是这份；坏包则把设置清空。
 *
 * 纯校验在 @shared/glossary-pack，这里只做文件读写与装配。
 */
import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setGlossaryEntries } from '@shared/dota-glossary'
import {
  bundledGlossaryStatus,
  glossaryStatusOf,
  parseGlossaryPack,
  type GlossaryPackStatus
} from '@shared/glossary-pack'
import { loadSettings, saveSettings } from './settings'

/** 探针用的目录覆盖（#141）：探针只许在自己 mkdtemp 出来的目录里造包，绝不碰真数据目录。 */
let dirOverride: string | null = null

export function setGlossaryDirForProbe(dir: string | null): void {
  dirOverride = dir
}

function packDir(): string {
  return dirOverride ?? join(app.getPath('userData'), 'glossary')
}

/**
 * 数据目录里能用的包名（文件名去掉 .json），面板据此列选项。
 *
 * 每次都重新扫目录（#141）：开机那次缓存曾经让「运行中丢一个包进去」永远看不见。
 * 目录里就那么几个文件，读一次比维护一份会过期的缓存便宜。
 */
function packNames(): string[] {
  try {
    return readdirSync(packDir())
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .sort()
  } catch {
    return []
  }
}

let status: GlossaryPackStatus = bundledGlossaryStatus()

/** 面板读取：现役词表 + 目录里现在有哪些包。清单永远现扫，不做启动时缓存。 */
export function glossaryPackStatus(): GlossaryPackStatus {
  const available = packNames()
  const changed =
    available.length !== status.available.length || available.some((name, index) => name !== status.available[index])
  if (changed) status = { ...status, available }
  return status
}

/**
 * 装一个包；空名 = 回退内置。文件不存在、不是 JSON、字段不合法都算坏包：
 * 照样回退内置，但把原因留在 status 里。
 */
export function applyGlossaryPackName(name: string): GlossaryPackStatus {
  const wanted = (name ?? '').trim()
  const available = packNames()
  if (!wanted) {
    setGlossaryEntries(null)
    status = bundledGlossaryStatus(null, available)
    console.log('GLOSSARY_PACK ' + JSON.stringify({ name: '', source: 'bundled', entries: status.entries }))
    return status
  }
  const file = `${wanted}.json`
  const path = join(packDir(), file)
  let reason: string | null = null
  let raw: unknown = null
  if (!existsSync(path)) {
    reason = `找不到 glossary/${file}`
  } else {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      reason = `glossary/${file} 不是合法 JSON`
    }
  }
  if (reason === null) {
    const parsed = parseGlossaryPack(raw)
    if (parsed.ok) {
      setGlossaryEntries(parsed.pack.entries)
      status = glossaryStatusOf(parsed.pack, file, available)
      console.log(
        'GLOSSARY_PACK ' +
          JSON.stringify({ name: parsed.pack.name, source: 'pack', file, entries: status.entries }),
      )
      return status
    }
    reason = `glossary/${file}: ${parsed.error}`
  }
  setGlossaryEntries(null)
  status = bundledGlossaryStatus(reason, available, file)
  console.log('GLOSSARY_PACK_FALLBACK ' + JSON.stringify({ file, reason }))
  return status
}

/** 开机按设置装一次：选过包的用户开机即生效，没选过就是内置表。 */
export function startGlossaryPack(): GlossaryPackStatus {
  return applyGlossaryPackName(loadSettings().glossaryPackName)
}

/** 面板点了某个包：装它并把选择写进设置；坏包把设置清空，避免每次开机都报同一条警告。 */
export function chooseGlossaryPack(name: string): GlossaryPackStatus {
  const next = applyGlossaryPackName(name)
  saveSettings({ glossaryPackName: next.source === 'pack' ? name.trim() : '' })
  return next
}
