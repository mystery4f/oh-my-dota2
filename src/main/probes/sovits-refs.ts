import { app } from 'electron'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSafeRelPath,
  listSovitsRefs,
  readRefsRaw,
  sovitsRefsFile,
  sovitsRefsRoot,
  writeRefsRaw
} from '../services/voice/sovits-refs'

/**
 * 参考音频库探针（--sovits-refs-probe）：纯读写临时目录，不碰真实数据根。
 * 逐组验证 listSovitsRefs 的外部行为：索引缺失、坏 JSON、非数组、
 * 缺失音频过滤、越界/绝对路径拒绝、相对路径按库根解析、正常清单字段齐全。
 */
export async function runSovitsRefsProbe(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'oh-my-dota2-sovits-refs-'))
  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const push = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
  }
  try {
    // 索引缺失：全新安装还没建库，必须是空清单而不是报错。
    const emptyRoot = join(base, 'empty')
    mkdirSync(emptyRoot, { recursive: true })
    push('索引缺失返回空清单', listSovitsRefs(emptyRoot).length === 0)

    // 坏 JSON：手编文件少个逗号，按空清单降级，不能抛。
    const badRoot = join(base, 'bad')
    mkdirSync(badRoot, { recursive: true })
    writeFileSync(join(badRoot, 'refs.json'), '{ not json', 'utf-8')
    push('坏 JSON 返回空清单', listSovitsRefs(badRoot).length === 0)

    // 非数组：写成单个对象同样降级。
    const objRoot = join(base, 'obj')
    mkdirSync(objRoot, { recursive: true })
    writeFileSync(join(objRoot, 'refs.json'), '{"name":"米拉娜"}', 'utf-8')
    push('非数组索引返回空清单', listSovitsRefs(objRoot).length === 0)

    // 正常清单 + 坏条目各一条：缺音频、越界、绝对路径、缺转写、坏语言。
    const root = join(base, 'lib')
    mkdirSync(join(root, 'mirana'), { recursive: true })
    writeFileSync(join(root, 'mirana', 'spawn13.mp3'), 'fake', 'utf-8')
    writeFileSync(
      join(root, 'refs.json'),
      JSON.stringify([
        { name: '米拉娜', audio: 'mirana/spawn13.mp3', promptText: '从银夜森林到太阳帝权', promptLang: 'zh' },
        { name: '音频丢失', audio: 'mirana/missing.mp3', promptText: 'x', promptLang: 'zh' },
        { name: '越界路径', audio: '../escape.mp3', promptText: 'x', promptLang: 'zh' },
        { name: '绝对路径', audio: 'C:/elsewhere/a.wav', promptText: 'x', promptLang: 'zh' },
        { name: '缺转写', audio: 'mirana/spawn13.mp3', promptLang: 'zh' },
        { name: '坏语言', audio: 'mirana/spawn13.mp3', promptText: 'x', promptLang: 'jp' }
      ]),
      'utf-8'
    )
    const refs = listSovitsRefs(root)
    push('坏条目与缺失音频被过滤', refs.length === 1, `得到 ${refs.length} 条`)
    const mirana = refs[0]
    push(
      '正常清单字段齐全',
      !!mirana && mirana.name === '米拉娜' && mirana.promptLang === 'zh' && mirana.promptText === '从银夜森林到太阳帝权',
      mirana ? `${mirana.name}/${mirana.promptLang}` : 'none'
    )
    push(
      '相对路径按库根解析成绝对路径',
      !!mirana && mirana.audioPath === join(root, 'mirana', 'spawn13.mp3'),
      mirana?.audioPath
    )
    push('sovitsRefsRoot 拼在数据根下', sovitsRefsRoot(join('D:', 'data')) === join('D:', 'data', 'tts', 'sovits-refs'))

    // 微调权重：条目可声明 gptWeights/sovitsWeights（相对权重根），文件在盘上才放行。
    const weightsRoot = join(base, 'weights')
    mkdirSync(join(weightsRoot, 'windranger'), { recursive: true })
    writeFileSync(join(weightsRoot, 'windranger', 'gpt.ckpt'), 'w', 'utf-8')
    writeFileSync(join(weightsRoot, 'windranger', 'sovits.pth'), 'w', 'utf-8')
    const tunedRoot = join(base, 'tuned')
    mkdirSync(join(tunedRoot, 'windranger'), { recursive: true })
    writeFileSync(join(tunedRoot, 'windranger', 'ref.wav'), 'fake', 'utf-8')
    writeFileSync(
      join(tunedRoot, 'refs.json'),
      JSON.stringify([
        {
          name: '风行者',
          audio: 'windranger/ref.wav',
          promptText: '谁能预测到这一幕',
          promptLang: 'zh',
          gptWeights: 'windranger/gpt.ckpt',
          sovitsWeights: 'windranger/sovits.pth'
        },
        {
          name: '权重文件缺失',
          audio: 'windranger/ref.wav',
          promptText: 'x',
          promptLang: 'zh',
          gptWeights: 'windranger/gone.ckpt',
          sovitsWeights: 'windranger/sovits.pth'
        },
        {
          name: '权重只写一半',
          audio: 'windranger/ref.wav',
          promptText: 'x',
          promptLang: 'zh',
          gptWeights: 'windranger/gpt.ckpt'
        },
        {
          name: '权重越界',
          audio: 'windranger/ref.wav',
          promptText: 'x',
          promptLang: 'zh',
          gptWeights: '../escape.ckpt',
          sovitsWeights: 'windranger/sovits.pth'
        }
      ]),
      'utf-8'
    )
    const tuned = listSovitsRefs(tunedRoot, weightsRoot)
    push('权重缺失/半对/越界的条目被剔除', tuned.length === 1, `得到 ${tuned.length} 条`)
    const ranger = tuned[0]
    push(
      '带权重的条目解析出绝对权重路径',
      !!ranger &&
        ranger.gptWeightsPath === join(weightsRoot, 'windranger', 'gpt.ckpt') &&
        ranger.sovitsWeightsPath === join(weightsRoot, 'windranger', 'sovits.pth'),
      ranger ? `${ranger.gptWeightsPath}/${ranger.sovitsWeightsPath}` : 'none'
    )
    push('不传权重根时带权重条目按无法核实剔除', listSovitsRefs(tunedRoot).length === 0)

    // 写入口：所有 refs.json 写入走同一个函数，格式、缩进、尾换行、坏文件备份都只在这里定义。
    const storeRoot = join(base, 'store')
    const foreign = [
      { name: '外来条目', audio: 'user/a.wav', promptText: 'x', promptLang: 'zh', custom: 1 },
      { name: '第二条', audio: 'user/b.wav', promptText: 'y', promptLang: 'en' }
    ]
    writeRefsRaw(storeRoot, foreign)
    const storeFile = sovitsRefsFile(storeRoot)
    push('写入口末尾带换行', readFileSync(storeFile, 'utf-8').endsWith('\n'))
    push(
      '写入口不留临时文件',
      readdirSync(storeRoot).every((name) => !name.endsWith('.tmp')),
      readdirSync(storeRoot).join(',')
    )
    push('未知字段与顺序原样保留', JSON.stringify(readRefsRaw(storeRoot)) === JSON.stringify(foreign))

    // 坏文件：写回前必须改名备份，内容一字不动，库按空表继续。
    const brokenStore = join(base, 'broken-store')
    mkdirSync(brokenStore, { recursive: true })
    writeFileSync(join(brokenStore, 'refs.json'), '{ 半个对象', 'utf-8')
    writeRefsRaw(brokenStore, [])
    const brokenFiles = readdirSync(brokenStore)
    const backup = brokenFiles.find((name) => name.includes('.broken-'))
    push('坏文件写前改名备份', !!backup, brokenFiles.join(','))
    push('备份内容与原文件一致', !!backup && readFileSync(join(brokenStore, backup), 'utf-8') === '{ 半个对象')
    push('坏文件重建后是空表', readRefsRaw(brokenStore).length === 0)

    // 相对路径规则：库内路径与清单路径共用一条，只在选项上分叉。
    push('相对路径接受 目录/文件', isSafeRelPath('mirana/a.wav'))
    push(
      '相对路径拒绝空段/点段/绝对/盘符/反斜杠',
      ['a//b', 'a/./b', '../x', 'a/../b', '/abs/c.wav', 'C:/x.wav', 'a\\b.wav'].every((p) => !isSafeRelPath(p))
    )
    push('清单规则要求至少两段', !isSafeRelPath('a.wav', { requireDir: true }))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'SOVITS_REFS_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}
