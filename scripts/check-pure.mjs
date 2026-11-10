#!/usr/bin/env node
/**
 * 纯逻辑断言：`src/shared/` 里那些「只看输入就该有确定输出」的函数，不启动 Electron 也能验。
 *
 * 为什么要有这个脚本：这些函数此前只能靠 `electron out/main/index.js --<probe>` 验，
 * 而探针要求独占应用（用户在别处用着应用时根本跑不了），于是每次改动只能手搓
 * `.tmp/*.mjs`、跑完删掉，下一次又从头来。这里把它们固定成一组断言，进 `npm run lint`。
 *
 * 代价与边界：只放**纯函数**（不读文件、不读设置、不 import 主进程）。有副作用的东西仍归探针。
 *
 * 跑法：node --experimental-strip-types scripts/check-pure.mjs（Node 22 需要这个开关）。
 */
import { registerHooks } from 'node:module'
import { pureResolve } from './pure-resolve.mjs'

// 先装钩子再 import：`src/shared/` 的 import 不带扩展名，Node 解析器需要被补全一次。
registerHooks({ resolve: pureResolve })
const { gradeAsrCheck, gradeSpoken, normalizeSpoken, summarizeAsrCheck } = await import('../src/shared/train/asr-check.ts')
const { FT_TARGET_STEPS, deriveFtEpochsFor, deriveFtResumeEpochs } = await import('../src/shared/train/asr-ft.ts')

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`)
    return
  }
  failed++
  console.log(`FAIL ${name}${detail ? ` (${detail})` : ''}`)
}

// —— 识别比对口径（全量识别比对 / 探针都读这几个函数）——
check('比对：标点与空白不算差异', gradeSpoken('我的跳刀还没好', '我的跳刀还没好。').grade === 'same')
check('比对：差 1 字算差一点', gradeSpoken('对面在偷盾，快回来', '对面在偷蹲快回来。').grade === 'near')
check('比对：差得多算明显错', gradeSpoken('我方高地塔要掉了先撤', '我们高地要掉了。').grade === 'wrong')
check('比对：归一化后全角标点也去掉', normalizeSpoken('Ａ，Ｂ。') === 'ａｂ'.toLowerCase())

const summary = summarizeAsrCheck([
  gradeAsrCheck('a', '我的跳刀还没好', '我的跳刀还没好。'),
  gradeAsrCheck('b', '对面在偷盾，快回来', '对面在偷蹲快回来。'),
  gradeAsrCheck('c', '我方高地塔要掉了先撤', '我们高地要掉了。')
])
check('比对：汇总三档分开数', summary.same === 1 && summary.near === 1 && summary.wrong === 1 && summary.total === 3)

// —— 训练轮数：数字错了就是训练时长错了，这里钉住当前的量级 ——
check('轮数：全量 qwen3 42 条按 110 步折算 10 轮', deriveFtEpochsFor('qwen3-sft', 42) === 10, String(deriveFtEpochsFor('qwen3-sft', 42)))
check(
  '轮数：续训 = ceil(上次步数 / 每轮步数) + 2',
  deriveFtResumeEpochs(42, 150) === 16,
  String(deriveFtResumeEpochs(42, 150))
)
check('轮数：续训总量恒大于上次步数', deriveFtResumeEpochs(42, 150) * 11 > 150)
check('轮数：数据为 0 也不返回 0', deriveFtEpochsFor('qwen3-sft', 0) > 0)
check('目标步数：全量 qwen3 的预算没被改动', FT_TARGET_STEPS === 110, String(FT_TARGET_STEPS))

// —— 对讲行的阶段留痕（voice-stage）：这行字是用户能看见的全部真相，一个字都不许漂 ——
const { formatStageTrace } = await import('../src/shared/voice-stage.ts')
check('留痕：一段都没走完就是「翻译中…」', formatStageTrace({ marks: [], current: 'translate' }) === '翻译中…')
check(
  '留痕：短段留存为标记，长段显示为进行中',
  formatStageTrace({ marks: [{ stage: 'translate', ms: 1 }, { stage: 'synth', ms: 2 }], current: 'playStart' }) ===
    '译 1ms · 合 2ms · 起播中…'
)
check(
  '留痕：播完只留事实，不再挂一个进行中',
  formatStageTrace({ marks: [{ stage: 'translate', ms: 1 }, { stage: 'play', ms: 1600 }], current: 'done' }) ===
    '译 1ms · 播 1.6s'
)

if (failed > 0) {
  console.log(`${failed} 条纯逻辑断言失败`)
  process.exit(1)
}
console.log('纯逻辑断言全部通过')
