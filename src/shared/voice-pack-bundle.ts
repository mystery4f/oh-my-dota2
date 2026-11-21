/**
 * #89：一个音色包 = 一个文件。
 *
 * 为什么要有这一层：音色包现在是「参考音频目录 + 两份权重 + refs.json 里的一条」，散在三个位置。
 * 分享给别人时漏一个文件，坏掉的方式是「说话没声」而不是「导入失败」——那是最难查的失败。
 * 所以包里带一份清单，导入前先逐件核对：缺哪一件就说哪一件的名字，而不是让它在合成时静默变声。
 *
 * 清单只描述「包里有什么、落在哪」。绝不写绝对路径：包是给别人用的，别人的数据根和你不一样。
 */

/** 包内的清单文件名（固定，导入时按这个名字找）。 */
export const VOICE_PACK_MANIFEST_FILE = 'voicepack.json'

/** 清单格式版本；不认识就拒收，不去猜测新字段的含义。 */
export const VOICE_PACK_BUNDLE_VERSION = 1

/** 一个音色包由这几件事组成；缺任何一项都导入不了。 */
export type VoicePackPart = 'manifest' | 'id' | 'name' | 'promptText' | 'promptLang' | 'refAudio' | 'gptWeights' | 'sovitsWeights'

export interface VoicePackBundleManifest {
  version: number
  id: string
  name: string
  promptText: string
  promptLang: 'zh' | 'en'
  /** 包内条目名（不是绝对路径）：参考音频 / GPT 权重 / SoVITS 权重各一件。 */
  refAudio: string
  gptWeights: string
  sovitsWeights: string
  createdAt?: string
  note?: string
}

export interface VoicePackPartError {
  part: VoicePackPart
  /** 人话：缺的是什么、它指向哪里。 */
  detail: string
}

export interface VoicePackCheck {
  ok: boolean
  errors: VoicePackPartError[]
}

/** 面板与日志里用的名字；报错要指名道姓，不然用户只看到「包坏了」。 */
export const VOICE_PACK_PART_LABELS: Record<VoicePackPart, string> = {
  manifest: '清单 voicepack.json',
  id: '音色 id',
  name: '音色名',
  promptText: '参考文本',
  promptLang: '参考语言',
  refAudio: '参考音频',
  gptWeights: 'GPT 权重',
  sovitsWeights: 'SoVITS 权重'
}

/** 音频必须是 wav：别的格式在合成侧根本读不了。 */
const REF_AUDIO_EXT = /\.wav$/i

/**
 * 导入前的唯一验门。
 *
 * `names` 是包里真实存在的条目名集合——清单说自己有、包里没有，就是「缺件」，
 * 而不是「清单写错了」：两者对用户是同一件事（这个包不能用），但报错要说清是哪一件。
 */
export function judgeVoicePackBundle(input: { manifest: unknown; names: readonly string[] }): VoicePackCheck {
  const errors: VoicePackPartError[] = []
  const names = new Set(input.names)
  const manifest = input.manifest
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [{ part: 'manifest', detail: '包里没有可读的 voicepack.json' }] }
  }
  const row = manifest as Record<string, unknown>
  if (Number(row.version) !== VOICE_PACK_BUNDLE_VERSION) {
    return {
      ok: false,
      errors: [{ part: 'manifest', detail: `清单版本是 ${String(row.version)}，这个版本的程序只认 ${VOICE_PACK_BUNDLE_VERSION}` }]
    }
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  if (text(row.id) === '') errors.push({ part: 'id', detail: '清单里没有音色 id' })
  if (text(row.name) === '') errors.push({ part: 'name', detail: '清单里没有音色名' })
  if (text(row.promptText) === '') errors.push({ part: 'promptText', detail: '清单里没有参考文本（参考音频要配一句话）' })
  const lang = text(row.promptLang)
  if (lang !== 'zh' && lang !== 'en') errors.push({ part: 'promptLang', detail: `参考语言只能是 zh 或 en，清单里是「${lang || '空'}」` })
  const parts: Array<[VoicePackPart, unknown]> = [
    ['refAudio', row.refAudio],
    ['gptWeights', row.gptWeights],
    ['sovitsWeights', row.sovitsWeights]
  ]
  for (const [part, raw] of parts) {
    const name = text(raw)
    if (name === '') {
      errors.push({ part, detail: `清单里没写${VOICE_PACK_PART_LABELS[part]}的文件名` })
      continue
    }
    if (!names.has(name)) {
      errors.push({ part, detail: `清单指向的${VOICE_PACK_PART_LABELS[part]}「${name}」不在包里` })
      continue
    }
    if (part === 'refAudio' && !REF_AUDIO_EXT.test(name)) {
      errors.push({ part, detail: `参考音频必须是 wav，「${name}」不是` })
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 一句能贴给用户的话：第一个缺件说具体，其余只说还有几件。 */
export function voicePackCheckLine(check: VoicePackCheck): string {
  if (check.ok) return '音色包完整'
  const [first, ...rest] = check.errors
  const head = `${VOICE_PACK_PART_LABELS[first.part]}：${first.detail}`
  return rest.length === 0 ? `这个包不能用 —— ${head}` : `这个包不能用 —— ${head}（还有 ${rest.length} 处）`
}

/** 清单里各件的条目名，导入时按它取文件（顺序即落位顺序）。 */
export function voicePackBundleEntries(manifest: VoicePackBundleManifest): Array<{ part: VoicePackPart; name: string }> {
  return [
    { part: 'refAudio', name: manifest.refAudio },
    { part: 'gptWeights', name: manifest.gptWeights },
    { part: 'sovitsWeights', name: manifest.sovitsWeights }
  ]
}
