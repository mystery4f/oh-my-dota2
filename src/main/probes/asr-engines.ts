import { existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'
import { ASR_ENGINE_LIST, ASR_ENGINES, requiredPathsAll } from '@shared/asr/engines'
import {
  collectAsrModels,
  defaultActiveModelId,
  engineForRel,
  matchesDirPattern,
  pickActiveAsrModel,
  sherpaKindFor,
  type AsrDirFact
} from '@shared/asr/models'
import { locateWorkerScript } from '../services/voice/runtime'

/**
 * `--asr-engines-probe`：ASR 引擎表与模型注册表的锁。
 *
 * 钉住三件事：
 * - 表自身站得住（现役目录归属得到、下载清单有体积与哈希、微调产物是必备文件的子集）；
 * - 表与 worker 的适配器键**双向相等**——漏写一个引擎的适配器会红，而不是运行时静默；
 * - 注册表与现役回落规则（含「刚点的那份还没 ready 也算选中」）。
 */

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []

function push(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

/** worker 里 ASR_KINDS 表的键：两个空格缩进的 `key: (request) =>` 行。 */
function workerKindKeys(): string[] {
  let source = ''
  try {
    source = readFileSync(locateWorkerScript('asr-sherpa-worker.cjs'), 'utf8')
  } catch {
    return []
  }
  const block = /const ASR_KINDS = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  return [...block.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1] as string)
}

export function runAsrEnginesProbe(): void {
  // —— 表自身 ——
  push('表：至少一个引擎', ASR_ENGINE_LIST.length > 0, `${ASR_ENGINE_LIST.length} 个`)
  for (const spec of ASR_ENGINE_LIST) {
    push(`表：${spec.id} 的 id 与表键一致`, ASR_ENGINES[spec.id] === spec, spec.id)
    push(`表：${spec.id} 有目录模式`, spec.dirPatterns.length > 0, spec.dirPatterns.join(' | '))
    push(`表：${spec.id} 有必备文件`, spec.requiredPaths.length > 0, spec.requiredPaths.join(' | '))
    push(
      `表：${spec.id} 的现役目录能被自己的模式匹配到`,
      spec.dirPatterns.some((pattern) => matchesDirPattern(pattern, spec.canonicalRel)),
      spec.canonicalRel
    )
    push(`表：${spec.id} 有代价说明`, spec.note.length > 0, spec.note)
    if (spec.download) {
      const bad = spec.download.files.filter((file) => !(file.bytes > 0) || !/^[0-9a-f]{64}$/.test(file.sha256))
      push(`表：${spec.id} 下载清单每件都有体积与 sha256`, bad.length === 0, `${spec.download.files.length} 件，坏 ${bad.length}`)
      push(`表：${spec.id} 下载仓库形状`, /^[^/]+\/[^/]+$/.test(spec.download.repo), spec.download.repo)
    }
    if (spec.finetune) {
      const ft = spec.finetune
      push(`表：${spec.id} 微调有训练脚本`, ft.trainScripts.length > 0 || ft.trainer === 'funasr-paraformer', ft.trainScripts.join(' | ') || 'python -m funasr.bin.train')
      push(
        `表：${spec.id} 微调有导出脚本`,
        ft.exportScripts.length > 0 || Boolean(ft.exportTool) || ft.trainer === 'funasr-paraformer',
        ft.exportScripts.join(' | ') || ft.exportTool || 'python -m funasr.bin.export'
      )
      push(
        `表：${spec.id} 打包的导出工具真在 resources 里`,
        !ft.exportTool || existsSync(locateWorkerScript(ft.exportTool)),
        ft.exportTool || '（用训练腿自带脚本）'
      )
      push(
        `表：${spec.id} 微调有底模（本地目录或 hub id）`,
        ft.baseModelDirs.length > 0 || ft.baseModelIds.length > 0,
        ft.baseModelDirs.join(' | ') || ft.baseModelIds.join(' | ')
      )
      push(
        `表：${spec.id} 微调产物都落进必备文件`,
        ft.artifacts.length > 0 && ft.artifacts.every((item) => spec.requiredPaths.includes(item.to)),
        ft.artifacts.map((item) => `${item.from}→${item.to}`).join(' | ')
      )
      push(
        `表：${spec.id} 装环境要的包都在体检清单里`,
        ft.pips.every((pip) => ft.pythonExtra.includes(pip.split('==')[0])),
        ft.pips.join(' | ') || '（都在安装器冻结清单里）'
      )
    } else {
      push(`表：${spec.id} 不支持微调要写明`, spec.finetune === null, 'null')
    }
  }
  const allPaths = requiredPathsAll()
  push('表：必备文件清单去重', new Set(allPaths).size === allPaths.length, `${allPaths.length} 条`)

  // —— 表与 worker 的适配器键双向相等 ——
  const tableKinds = ASR_ENGINE_LIST.map((spec) => spec.sherpaKind).sort()
  const workerKinds = workerKindKeys().sort()
  push(
    'worker：适配器键与本表完全一致（漏一个引擎会红）',
    workerKinds.length > 0 && JSON.stringify(tableKinds) === JSON.stringify(workerKinds),
    `表 ${tableKinds.join(',')} / worker ${workerKinds.join(',') || '（读不到 ASR_KINDS）'}`
  )

  // —— 归属判定 ——
  const attribution = [
    ['asr-models/qwen3-asr', 'qwen3'],
    ['asr-models/qwen3-asr.bak', 'qwen3'],
    ['asr-models/qwen3-asr.next', 'qwen3'],
    ['asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25', 'qwen3'],
    ['voice-runtime/models/qwen3-asr', 'qwen3']
  ] as const
  for (const [rel, engine] of attribution) {
    push(`归属：${rel} → ${engine}`, engineForRel(rel)?.id === engine, engineForRel(rel)?.id ?? 'null')
  }
  push('归属：退役目录 sense-voice 不归任何引擎', engineForRel('asr-models/sense-voice') === null, 'null')

  // —— 注册表 ——
  const qwen = ASR_ENGINES.qwen3
  const readySizes = Object.fromEntries(qwen.requiredPaths.map((path) => [path, 1000]))
  const facts: AsrDirFact[] = [
    { rel: 'asr-models/qwen3-asr', sizes: readySizes, bytes: 986491745 },
    { rel: 'asr-models/qwen3-asr.bak', sizes: { [qwen.requiredPaths[0] as string]: 1 }, bytes: 10 },
    { rel: 'asr-models/qwen3-asr.next', sizes: {}, bytes: 0 },
    { rel: 'asr-models/sense-voice', sizes: {}, bytes: 5 }
  ]
  const models = collectAsrModels(facts)
  push('注册表：退役目录被丢掉', models.length === 3, `${models.length} 条`)
  push('注册表：ready 的排在最前', models[0]?.rel === 'asr-models/qwen3-asr' && models[0]?.ready === true, models[0]?.id ?? '空')
  push(
    '注册表：id 形状是 engine:rel',
    models.every((model) => model.id === `${model.engineId}:${model.rel}`),
    models.map((model) => model.id).join(' | ')
  )
  push(
    '注册表：来源分类 download / backup / finetuned',
    models.map((model) => model.origin).join(',') === 'download,backup,finetuned',
    models.map((model) => `${model.rel}=${model.origin}`).join(' | ')
  )
  push(
    '注册表：备份与待转正带后缀标签',
    models.some((model) => model.label.endsWith('（备份）')) && models.some((model) => model.label.endsWith('（待转正）')),
    models.map((model) => model.label).join(' | ')
  )
  push('注册表：空输入得空列表', collectAsrModels([]).length === 0, '0 条')
  push(
    '注册表：sherpaKind 从表里取',
    models.every((model) => sherpaKindFor(model) === qwen.sherpaKind),
    sherpaKindFor(models[0] as (typeof models)[number])
  )

  // —— 现役回落 ——
  push('现役：id 命中就用它', pickActiveAsrModel(models, 'qwen3:asr-models/qwen3-asr.next')?.rel === 'asr-models/qwen3-asr.next', 'next 被选中')
  push('现役：id 失配回落第一条 ready', pickActiveAsrModel(models, 'qwen3:不存在')?.rel === 'asr-models/qwen3-asr', pickActiveAsrModel(models, 'x')?.rel ?? 'null')
  const notReadyOnly = collectAsrModels([{ rel: 'asr-models/qwen3-asr.next', sizes: {}, bytes: 0 }])
  push('现役：一条 ready 都没有 → null', pickActiveAsrModel(notReadyOnly, '') === null, 'null')
  push('现役：设置里没 id 时默认取第一条 ready', defaultActiveModelId(models) === 'qwen3:asr-models/qwen3-asr', defaultActiveModelId(models))
  push('现役：全空时默认 id 是空串', defaultActiveModelId([]) === '', '空串')

  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`ASR_ENGINES_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}
