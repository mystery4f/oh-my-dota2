/**
 * 给 `check-pure.mjs` 用的解析钩子：`src/shared/` 里的相对 import 不写扩展名（TypeScript 习惯），
 * 而 Node 的 ESM 解析器要求写全。这里只在「相对路径 + 没有扩展名」时补 `.ts` / `/index.ts`，
 * 其余一概交给默认解析——不做路径重写、不认别名（别名是 Vite 的，跑不了就是跑不了）。
 */
import { existsSync } from 'node:fs'

export function pureResolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s|json)$/.test(specifier) && context.parentURL) {
    for (const suffix of ['.ts', '/index.ts']) {
      const candidate = new URL(specifier + suffix, context.parentURL)
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
