import { app } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSovitsRefs, sovitsRefsRoot } from '../services/voice/sovits-refs'

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
