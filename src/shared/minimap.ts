/**
 * 小地图血点检测（#134 的测量件）。
 *
 * 这一层只做**可测的机械活**：把一块 RGBA 里的红/绿像素按连通域聚成点，返回质心与面积。
 * 「这个点到底是英雄还是小兵」不在这里判断——那需要带标注的真实帧，而标注是人的工作。
 * 把判断塞进代码里会让测量失去意义：检测器自己挑的阈值再去评估自己，永远是满分。
 *
 * 阈值照抄 dota2-coach 的做法（HSV 红 hue 0-10 与 160-180、绿 35-85），但这里用的是
 * RGB 直接判，避免一次 ImageData → HSV 的全量转换：小地图只有两百多像素见方，
 * 省下来的是每帧几毫秒，而这正是票面要量的东西。
 */

export interface DotBox {
  /** 质心，相对裁剪区左上角。 */
  x: number
  y: number
  /** 命中像素数：小兵的点比英雄略小，这是唯一能用来分流的粗糙线索。 */
  area: number
}

export interface DotRules {
  /** 红点最小面积（像素）。低于这个数的多半是特效噪声。 */
  minRed: number
  /** 绿点最小面积。 */
  minGreen: number
}

export const DEFAULT_DOT_RULES: DotRules = { minRed: 12, minGreen: 12 }

/** 红色：R 明显高于 G/B，且不是棕色的地面纹理。 */
export function isRedPixel(r: number, g: number, b: number): boolean {
  return r >= 140 && r - g >= 60 && r - b >= 50
}

/** 绿色：G 明显高于 R/B；Dota 的绿比红暗，阈值要低一些。 */
export function isGreenPixel(r: number, g: number, b: number): boolean {
  return g >= 120 && g - r >= 50 && g - b >= 40
}

/**
 * 按行扫描做连通域（行程 + 并查集合并），一次遍历像素。
 * 不引任何图像库：这里要的是「一帧几毫秒」，加一个依赖只会让测量变糊。
 */
export function detectDots(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  colour: 'red' | 'green',
  rules: DotRules = DEFAULT_DOT_RULES
): DotBox[] {
  const test = colour === 'red' ? isRedPixel : isGreenPixel
  const minArea = colour === 'red' ? rules.minRed : rules.minGreen
  // 每个行程（一行里连续命中的像素段）记录归属的连通域 id，最后按 id 汇总。
  const parent: number[] = []
  const sumX: number[] = []
  const sumY: number[] = []
  const area: number[] = []
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    parent[rb] = ra
    sumX[ra] += sumX[rb]
    sumY[ra] += sumY[rb]
    area[ra] += area[rb]
  }

  let previous: { start: number; end: number; id: number }[] = []
  for (let y = 0; y < height; y += 1) {
    const current: { start: number; end: number; id: number }[] = []
    let x = 0
    while (x < width) {
      const at = (y * width + x) * 4
      if (!test(rgba[at], rgba[at + 1], rgba[at + 2])) {
        x += 1
        continue
      }
      const start = x
      while (x < width) {
        const i = (y * width + x) * 4
        if (!test(rgba[i], rgba[i + 1], rgba[i + 2])) break
        x += 1
      }
      const end = x - 1
      const id = parent.length
      parent.push(id)
      sumX.push(0)
      sumY.push(0)
      area.push(0)
      current.push({ start, end, id })
    }
    // 与上一行重叠的行程合并（8 邻域近似：只看左右各一格）。
    for (const run of current) {
      for (const prev of previous) {
        // 8 邻域：上一行的行程与本行左右各扩一格有交叠，就算同一块。
        if (prev.start <= run.end + 1 && run.start <= prev.end + 1) union(prev.id, run.id)
      }
    }
    for (const run of current) {
      const root = find(run.id)
      for (let px = run.start; px <= run.end; px += 1) {
        sumX[root] += px
        sumY[root] += y
        area[root] += 1
      }
    }
    previous = current
  }

  const dots: DotBox[] = []
  for (let id = 0; id < parent.length; id += 1) {
    if (find(id) !== id) continue
    if (area[id] < minArea) continue
    dots.push({ x: sumX[id] / area[id], y: sumY[id] / area[id], area: area[id] })
  }
  return dots
}
