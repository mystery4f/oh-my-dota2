/**
 * 探针清单（#112）：面板能列出来的那一份，以及为什么不能从面板里跑。
 *
 * 只有一份真相：`src/main/probes/registry.ts`。这里不做第二份清单，只把登记表里的
 * `readOnly` 标记翻译成「面板怎么显示、点了会怎样说」。
 *
 * 为什么面板里不能真的跑：探针进程要拿 Electron 的单实例锁（`src/main/index.ts:157`
 * 无条件 `requestSingleInstanceLock()`），应用开着时第二个实例直接退出；而且探针跑完
 * 会自己 `app.exit()`——在应用进程里跑等于把应用关掉。所以面板的角色是**列清单 +
 * 说清楚为什么只能去命令行跑**，不是假装能跑。
 */

/** 登记表里这一行需要的最小信息（避免 shared 层反向依赖主进程类型）。 */
export interface ProbeRef {
  flag: string
  summary: string
  readOnly?: true
}

/** 面板里的一条：`runHint` 是点「运行」时给的那句话，绝不留空。 */
export interface ProbeCatalogEntry {
  flag: string
  summary: string
  readOnly: boolean
  runHint: string
}

export interface ProbeCatalog {
  entries: ProbeCatalogEntry[]
  readOnly: number
  exclusive: number
}

/** 只读探针点了之后的说法：给出能用的那条命令。 */
export function readOnlyRunHint(flag: string): string {
  return `面板里只列清单，不跑：探针要拿单实例锁、跑完自己退出应用。要在命令行跑：npm run probe -- ${flag}`
}

/** 要独占资源的那些连命令都要提醒一句。 */
export function exclusiveRunHint(flag: string): string {
  return `这条会占端口/音频设备或写真实日志（要独占）：先退出应用，再跑 npm run probe -- ${flag}`
}

/** 把登记表翻成面板清单。顺序跟登记表一致，方便对号。 */
export function catalogOf(rows: readonly ProbeRef[]): ProbeCatalog {
  const entries: ProbeCatalogEntry[] = rows.map((row) => {
    const readOnly = row.readOnly === true
    return {
      flag: row.flag,
      summary: row.summary,
      readOnly,
      runHint: readOnly ? readOnlyRunHint(row.flag) : exclusiveRunHint(row.flag)
    }
  })
  const readOnly = entries.filter((entry) => entry.readOnly).length
  return { entries, readOnly, exclusive: entries.length - readOnly }
}

/** 一行摘要：`只读 33 条 · 需独占 27 条`。 */
export function catalogLine(catalog: ProbeCatalog): string {
  return `只读 ${catalog.readOnly} 条 · 需独占 ${catalog.exclusive} 条`
}