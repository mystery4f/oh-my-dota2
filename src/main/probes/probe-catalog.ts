/**
 * --probe-catalog-probe：面板能看到的探针清单（#112）。
 *
 * 钉的是「清单不许变成第二份真相」：条数必须等于登记表、只读与独占的划分必须等于
 * `readOnly` 标记、每一条都必须给出一句能照着做的命令，没有任何一条假装能在面板里跑。
 */
import { PROBES } from './registry'
import { catalogLine, catalogOf, exclusiveRunHint, readOnlyRunHint } from '@shared/probe-catalog'
import { finishProbe, probeCases } from './harness'

export function runProbeCatalogProbe(): void {
  const { cases, push } = probeCases()
  const catalog = catalogOf(PROBES.map((row) => ({ flag: row.flag, summary: row.summary, readOnly: row.readOnly })))

  push('清单条数等于登记表的条数', catalog.entries.length === PROBES.length, `${catalog.entries.length}/${PROBES.length}`)

  const flagged = PROBES.filter((row) => row.readOnly === true).length
  push('只读条数等于登记表里标了 readOnly 的条数', catalog.readOnly === flagged, `${catalog.readOnly}/${flagged}`)
  push('只读 + 需独占 = 总数', catalog.readOnly + catalog.exclusive === catalog.entries.length)

  push('每条都有非空的说明', catalog.entries.every((entry) => entry.summary.trim() !== ''))

  const flags = catalog.entries.map((entry) => entry.flag)
  push('每条的 flag 都唯一', new Set(flags).size === flags.length)

  push(
    '每条的提示里都给出能照着做的命令',
    catalog.entries.every((entry) => entry.runHint.includes('npm run probe -- ' + entry.flag)),
    catalog.entries.find((entry) => !entry.runHint.includes(entry.flag))?.flag ?? ''
  )

  push(
    '只读那条的提示说的是「面板只列不跑」与单实例锁',
    catalog.entries.filter((entry) => entry.readOnly).every((entry) => entry.runHint.includes('单实例锁')),
    readOnlyRunHint('--gsi-dump-report')
  )

  push(
    '需独占那条的提示说的是「先退出应用」',
    catalog.entries.filter((entry) => !entry.readOnly).every((entry) => entry.runHint.includes('先退出应用')),
    exclusiveRunHint('--gsi-dump')
  )

  push(
    '没有任何一条声称能在面板里直接跑',
    catalog.entries.every((entry) => !/可以在这里跑|点一下就运行|直接运行/.test(entry.runHint))
  )

  push(
    '一行摘要给出两个数',
    catalogLine(catalog) === `只读 ${catalog.readOnly} 条 · 需独占 ${catalog.exclusive} 条`,
    catalogLine(catalog)
  )

  const fake = catalogOf([
    { flag: '--a-probe', summary: 'A', readOnly: true },
    { flag: '--b-probe', summary: 'B' }
  ])
  push(
    '划分只看标记：标了就是只读，没标就是独占',
    fake.readOnly === 1 && fake.exclusive === 1 && fake.entries[0].readOnly && !fake.entries[1].readOnly
  )
  push('顺序跟登记表一致（面板对号入座）', fake.entries.map((entry) => entry.flag).join(',') === '--a-probe,--b-probe')

  finishProbe('PROBE_CATALOG_PROBE', cases, {
    total: catalog.entries.length,
    readOnly: catalog.readOnly,
    exclusive: catalog.exclusive
  })
}
