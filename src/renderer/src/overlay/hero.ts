import type { CaptureEntry } from '@shared/ipc'

/**
 * 英雄头像：文件名（不含扩展名）就是 GSI 里的英雄内部名。
 * 构建期 glob 进 bundle，运行时零请求；没图就退化为不画头像。
 */
const HERO_ICONS = import.meta.glob('../../assets/heroes/*.png', {
  eager: true,
  import: 'default'
}) as Record<string, string>

const heroUrls = new Map<string, string>()
for (const [file, url] of Object.entries(HERO_ICONS)) {
  heroUrls.set(file.replace(/^.*\/(.*)\.png$/, '$1'), url)
}

/** 英雄内部名 → 可直接塞进 <img src> 的 URL；不认识的英雄返回 undefined。 */
export function heroUrl(hero: string | undefined): string | undefined {
  return hero ? heroUrls.get(hero) : undefined
}

export type { CaptureEntry }
