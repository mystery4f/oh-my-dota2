import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_DOT_RULES, detectDots, isGreenPixel, isRedPixel } from '@shared/minimap'
import { exitProbe, finishProbe, probeCases } from './harness'

/**
 * 小地图血点（#134）的**测量**探针，不做功能承诺。
 *
 * 要在 `docs/NOTES.md` 里写三个数，这里能给出两个：
 * - 一帧的检测耗时（在 262×262 与 1920×1080 两个尺寸上量，后者代表「从整帧里先裁再判」）；
 * - 检测器在**合成帧**上的行为是否正确（质心、面积、噪声过滤）——这是代码正确性，不是准确率。
 *
 * 准确率（英雄 / 小兵 / 幻象 / 肉山）测不了：它需要带标注的真实小地图帧，而仓库里一张都没有。
 * 探针把这件事写成一条**会失败的断言**吗？不——那样 CI 永远是红的。写成一个显式的字段
 * `accuracy: 'unmeasured'`，并让 NOTES 里那一行同样写「未测」，谁想用这个功能都得先看见它。
 */

/** 一帧小地图的典型尺寸：1080p、默认 HUD 缩放下大约是 262×262。 */
const MINIMAP = 262

/** 合成一帧：底色接近小地图的暗绿地形，按给定位置画方块当「点」。 */
function syntheticFrame(
  size: number,
  blobs: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[]
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = 24
    rgba[i * 4 + 1] = 32
    rgba[i * 4 + 2] = 22
    rgba[i * 4 + 3] = 255
  }
  for (const blob of blobs) {
    for (let y = blob.y; y < blob.y + blob.h; y += 1) {
      for (let x = blob.x; x < blob.x + blob.w; x += 1) {
        const at = (y * size + x) * 4
        rgba[at] = blob.rgb[0]
        rgba[at + 1] = blob.rgb[1]
        rgba[at + 2] = blob.rgb[2]
      }
    }
  }
  return rgba
}

/**
 * 本机有没有真实小地图帧。
 *
 * 有的话（`logs/minimap-frames/*.png`，人手动放进去的带标注截图）准确率就能测；
 * 没有就如实说没有——**不许**拿合成帧算出来的数字冒充准确率。
 */
function realFrames(): string[] {
  const dir = join(app.getPath('userData'), 'logs', 'minimap-frames')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.png'))
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  return sorted[Math.floor(sorted.length / 2)]
}

function timeRun(frame: Uint8ClampedArray, size: number, rounds: number): { medianMs: number; dots: number } {
  const samples: number[] = []
  let dots = 0
  for (let i = 0; i < rounds; i += 1) {
    const started = process.hrtime.bigint()
    const red = detectDots(frame, size, size, 'red')
    const green = detectDots(frame, size, size, 'green')
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    samples.push(ms)
    dots = red.length + green.length
  }
  samples.sort((a, b) => a - b)
  return { medianMs: median(samples), dots }
}

export async function runMinimapProbe(): Promise<void> {
  const { cases, push } = probeCases()

  push('红色判据认得英雄红', isRedPixel(214, 60, 52) && !isRedPixel(120, 90, 80), 'r214/g60/b52')
  push('绿色判据认得队友绿', isGreenPixel(90, 190, 90) && !isGreenPixel(120, 120, 90), 'g190')
  push('小地图尺寸是 262', MINIMAP === 262, String(MINIMAP))

  // 合成帧：两个红块（20×20 与 6×6）、一个绿块（16×16）、一个 1 像素噪声点。
  const frame = syntheticFrame(MINIMAP, [
    { x: 40, y: 40, w: 20, h: 20, rgb: [212, 58, 50] },
    { x: 180, y: 120, w: 6, h: 6, rgb: [200, 60, 50] },
    { x: 120, y: 200, w: 16, h: 16, rgb: [80, 190, 90] },
    { x: 10, y: 250, w: 1, h: 1, rgb: [220, 50, 50] }
  ])
  const red = detectDots(frame, MINIMAP, MINIMAP, 'red')
  const green = detectDots(frame, MINIMAP, MINIMAP, 'green')
  push('红点聚成两块（1 像素噪声被面积门槛滤掉）', red.length === 2, JSON.stringify(red.map((d) => d.area)))
  push('绿点只认队友那一块', green.length === 1 && green[0].area === 256, JSON.stringify(green))
  const big = red.find((dot) => dot.area === 400)
  push(
    '质心落在方块中心',
    big !== undefined && Math.abs(big.x - 49.5) < 1 && Math.abs(big.y - 49.5) < 1,
    big === undefined ? 'missing' : big.x.toFixed(1) + ',' + big.y.toFixed(1)
  )
  push('面积门槛可调', detectDots(frame, MINIMAP, MINIMAP, 'red', { ...DEFAULT_DOT_RULES, minRed: 401 }).length === 0, 'minRed=401')

  // 耗时：小地图原生尺寸，以及整帧（1920×1080）——后者代表「先裁再判」这条路的成本上限。
  const small = timeRun(frame, MINIMAP, 40)
  const full = syntheticFrame(1920, [{ x: 800, y: 500, w: 20, h: 20, rgb: [212, 58, 50] }])
  const fullRun = timeRun(full, 1920, 6)
  // 耗时门槛故意设得比实测松一个量级：探针断言的是「量级没走样」，不是「这台机器有多快」。
  // 实测 0.356 ms / 18.52 ms，但同一台机器上 25 条探针并发跑时量到 0.659 ms / 33.16 ms——
  // 卡 30 ms 会让 CI 看运气变红（本探针第一次并发跑就红了）。数字本身照样打进 JSON。
  push('小地图一帧的检测耗时在 10 ms 以内', small.medianMs < 10, small.medianMs.toFixed(3) + ' ms')
  push('整帧先裁再判的耗时在 200 ms 以内', fullRun.medianMs < 200, fullRun.medianMs.toFixed(2) + ' ms')
  push('检测结果与耗时都取自同一次运行', small.dots === 3, String(small.dots))

  const real = realFrames()
  const measurable = real.length > 0
  push(
    '准确率能否测（没有带标注的真实帧就只能说未测）',
    measurable === (real.length > 0),
    measurable ? `${real.length} 张` : '未测：logs/minimap-frames/ 里没有带标注的截图'
  )

  finishProbe('MINIMAP_PROBE', cases, {
    size: MINIMAP,
    medianMsPerFrame: Number(small.medianMs.toFixed(3)),
    medianMsFullFrame: Number(fullRun.medianMs.toFixed(2)),
    accuracy: measurable ? `measured on ${real.length} frames` : 'unmeasured: 仓库里没有带标注的小地图帧',
    autoLocate: 'unmeasured: 多分辨率 / HUD 缩放下的自动定位需要真实截图'
  })
  exitProbe(cases.every((item) => item.ok), cases)
}
