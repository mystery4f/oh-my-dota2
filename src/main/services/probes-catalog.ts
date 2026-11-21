/**
 * 面板能看到的探针清单（#112）。
 *
 * 唯一真相是 `src/main/probes/registry.ts`；这里只把它翻译成面板形状。
 * 不缓存：登记表是编译期常量，每次调用拼一遍比维护失效逻辑便宜。
 */
import { PROBES } from '../probes/registry'
import { catalogOf, type ProbeCatalog } from '@shared/probe-catalog'

export function probeCatalog(): ProbeCatalog {
  return catalogOf(PROBES.map((row) => ({ flag: row.flag, summary: row.summary, readOnly: row.readOnly })))
}
