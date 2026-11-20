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
const { gradeAsrCheck, gradeSpoken, summarizeAsrCheck } = await import('../src/shared/train/asr-check.ts')
const { formatCer, measureCer, normalizeSpoken, rankByCer, summarizeCer, summarizeCerByCohort } = await import('../src/shared/train/cer.ts')
const { FT_TARGET_STEPS, deriveFtEpochsFor, deriveFtResumeEpochs } = await import('../src/shared/train/asr-ft.ts')
const {
  EMPTY_TALLY,
  CANDIDATE_LIMIT,
  mergePlan,
  parseTally,
  rankCandidates,
  recordCorrection,
  dismissCandidates
} = await import('../src/shared/asr-hotword-candidates.ts')

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

// —— 逐条 CER（#47）：口径与排名只在 cer.ts，这里和探针各守一份用例 ——
check('CER：标点与空白不算字', measureCer('我回家补蓝，可以出来一起打', '我回家补蓝可以出来一起打').distance === 0, '')
check(
  'CER：错两字 2/13',
  (() => {
    const m = measureCer('我回家补下蓝可以出来一起打', '我回家补蓝可以出来一起大')
    return m.distance === 2 && m.chars === 13 && m.cer === 2 / 13
  })(),
  ''
)
check(
  'CER：原文空而识别有字算全错，两空算对',
  measureCer('', '跳刀').cer === 1 && measureCer('', '').cer === 0,
  ''
)
check(
  'CER：排名从差到好，同率大字先',
  (() => {
    const rows = rankByCer([
      { key: 'a', distance: 2, chars: 100, cer: 0.02 },
      { key: 'b', distance: 4, chars: 100, cer: 0.04 },
      { key: 'c', distance: 1, chars: 25, cer: 0.04 },
      { key: 'd', distance: 0, chars: 10, cer: 0 }
    ])
    return rows.map((row) => row.key).join() === 'b,c,a,d'
  })(),
  ''
)
check(
  'CER：合计不取平均，是总错字÷总字数',
  (() => {
    const s = summarizeCer([
      { key: 'a', distance: 0, chars: 100, cer: 0 },
      { key: 'b', distance: 1, chars: 1, cer: 1 }
    ])
    return s.distance === 1 && s.chars === 101 && s.cer === 1 / 101
  })(),
  ''
)
check(
  'CER：训练/留出必须分开报',
  (() => {
    const m = summarizeCerByCohort([
      { key: 'a', cohort: 'train', distance: 0, chars: 10, cer: 0 },
      { key: 'b', cohort: 'eval', distance: 2, chars: 10, cer: 0.2 }
    ])
    return m.train.rows === 1 && m.eval.cer === 0.2 && m.unknown.rows === 0
  })(),
  ''
)
check('CER：百分比四档', formatCer(0) === '0%' && formatCer(0.004) === '0.4%' && formatCer(0.061) === '6.1%' && formatCer(0.4) === '40%', '')
const summary = summarizeAsrCheck([
  gradeAsrCheck('a', '我的跳刀还没好', '我的跳刀还没好。'),
  gradeAsrCheck('b', '对面在偷盾，快回来', '对面在偷蹲快回来。'),
  gradeAsrCheck('c', '我方高地塔要掉了先撤', '我们高地要掉了。')
])
check('比对：汇总三档分开数', summary.same === 1 && summary.near === 1 && summary.wrong === 1 && summary.total === 3)

// —— 热词候选（#74）：纠错差异词
check(
  '热词候选：一次纠错记一个 ≥2 字候选，带原句样本',
  (() => {
    const tally = recordCorrection(EMPTY_TALLY, '我们打个哈斯卡', '我们打个马尔斯')
    return (
      tally.corrections === 1 &&
      tally.candidates.length === 1 &&
      tally.candidates[0].word === '马尔斯' &&
      tally.candidates[0].samples[0] === '我们打个哈斯卡'
    )
  })(),
  ''
)
check(
  '热词候选：同一个词纠三次 count=3，原句样本只收一次',
  (() => {
    const once = recordCorrection(EMPTY_TALLY, '我们打个哈斯卡', '我们打个马尔斯')
    const twice = recordCorrection(once, '我们打个哈斯卡', '我们打个马尔斯')
    const third = recordCorrection(twice, '我们打个哈斯卡', '我们打个马尔斯')
    const hit = third.candidates.find((c) => c.word === '马尔斯')
    return hit !== undefined && hit.count === 3 && hit.samples.length === 1
  })(),
  ''
)
check('热词候选：只改标点不进候选池', recordCorrection(EMPTY_TALLY, '打个', '打个！').candidates.length === 0, '')
check(
  '热词候选：池子满（40）了不新增候选，计数照记',
  (() => {
    let tally = EMPTY_TALLY
    for (let i = 0; i < CANDIDATE_LIMIT + 5; i += 1)
      tally = recordCorrection(tally, `改${i}废话`, `词${i}好话`)
    return tally.candidates.length === CANDIDATE_LIMIT && tally.corrections === CANDIDATE_LIMIT + 5
  })(),
  ''
)
check(
  '热词候选：已在表里的词记为 inTable',
  (() => {
    const tally = recordCorrection(EMPTY_TALLY, '我们打个哈斯卡', '我们打个马尔斯')
    return rankCandidates(tally.candidates, '马尔斯')[0].inTable === true
  })(),
  ''
)
check(
  '热词候选：合并计划把新增/已存在分开，next 是规范化串',
  (() => {
    const plan = mergePlan('冰甲,捍卫', ['捍卫', '肉山', '泰坦'])
    return plan.already.includes('捍卫') && plan.added.includes('肉山') && plan.next === '冰甲,捍卫,肉山,泰坦'
  })(),
  ''
)
check(
  '热词候选：表满时新词单独列出 dropped，next 不动',
  (() => {
    const full = Array.from({ length: 50 }, (_, i) => `词${i}`).join(',')
    const plan = mergePlan(full, ['泰坦'])
    return plan.dropped.includes('泰坦') && plan.next === full
  })(),
  ''
)
check(
  '热词候选：忽略只摘候选，计数不动',
  (() => {
    const once = recordCorrection(EMPTY_TALLY, '我们打个哈斯卡', '我们打个马尔斯')
    const dismissed = dismissCandidates(once, ['马尔斯'])
    return dismissed.corrections === 1 && dismissed.candidates.length === 0
  })(),
  ''
)
check(
  '热词候选：脏数据当空池',
  (() => {
    const junk = parseTally({ corrections: '三', candidates: [{ word: '甲', samples: 'x' }, { word: '' }, null] })
    return junk.corrections === 0 && junk.candidates.length === 0
  })(),
  ''
)
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

// —— 录音闸（voice-capture-gate）：这条判定决定「你说的话有没有被送去识别」，阈值不许漂 ——
const { MIN_SPEECH_MS, SILENCE_RMS, MIC_WARM_LEASE_MS, canReuseMic, captureLevel, capturePeak, judgeCapture, rejectLine } = await import(
  '../src/shared/voice-capture-gate.ts'
)
// —— Dota 2 显示模式：独占全屏上任何窗口都画不上去，「浮层不见了」最常是它 ——
const { DOTA_DISPLAY_LABEL, dotaDisplayWarning, parseDotaVideoMode } = await import('../src/shared/dota-video.ts')
const EXCLUSIVE = '"setting.fullscreen"\t\t"1"\n"setting.nowindowborder"\t\t"1"'
const BORDERLESS = '"setting.fullscreen"\t\t"0"\n"setting.nowindowborder"\t\t"1"'
const WINDOWED = '"setting.fullscreen"\t\t"0"\n"setting.nowindowborder"\t\t"0"'
check('显示模式：fullscreen=1 就是独占全屏（nowindowborder 拦不住它）', parseDotaVideoMode(EXCLUSIVE) === 'exclusive')
check('显示模式：fullscreen=0 且无边框 = 全屏窗口', parseDotaVideoMode(BORDERLESS) === 'borderless')
check('显示模式：fullscreen=0 且有边框 = 窗口', parseDotaVideoMode(WINDOWED) === 'windowed')
check('显示模式：缺关键项就认不出来（不猜）', parseDotaVideoMode('"setting.aspectratiomode"\t\t"1"') === null)
check(
  '显示模式：只有独占全屏要警告，其余不说废话',
  dotaDisplayWarning('exclusive')?.includes('全屏窗口') === true &&
    dotaDisplayWarning('borderless') === null &&
    dotaDisplayWarning('windowed') === null
)
check('显示模式：读不到也要说一句，别让人以为没这条检查', dotaDisplayWarning(null) !== null)
check('显示模式：三种模式都有中文名', Object.values(DOTA_DISPLAY_LABEL).every((label) => label.length > 0))
const quiet = judgeCapture({ frames: 1600, sampleRate: 16_000, rms: 0.001, peak: 0.001 })
check('录音闸：太短先判短（先看时长再看音量）', quiet.reason === 'too-short' && !quiet.ok, quiet.detail)
const hushed = judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: SILENCE_RMS - 0.004, peak: SILENCE_RMS - 0.001 })
check('录音闸：够长但没声音算静音', hushed.reason === 'silent', String(SILENCE_RMS))
check('录音闸：只看阈值下沿，等于阈值就放过', judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: SILENCE_RMS, peak: SILENCE_RMS }).ok)
check(
  '录音闸：三种理由各有一句给人看的话，且不重复',
  [quiet.line, hushed.line, judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: 0, peak: 0 }).line].every((line) => line.length > 0) &&
    new Set([quiet.line, hushed.line, judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: 0, peak: 0 }).line]).size === 3
)
check(
  '录音闸：0.3 秒是下沿（299 毫秒丢、300 毫秒过）',
  judgeCapture({ frames: (16_000 * (MIN_SPEECH_MS - 1)) / 1000, sampleRate: 16_000, rms: 0.5, peak: 0.5 }).reason === 'too-short' &&
    judgeCapture({ frames: (16_000 * MIN_SPEECH_MS) / 1000, sampleRate: 16_000, rms: 0.5, peak: 0.5 }).ok
)
check('录音闸：RMS 按块累计，不是取最后一块', Math.abs(captureLevel([new Float32Array(4).fill(0.5)], 4) - 0.5) < 1e-6)
check('录音闸：没有帧就没有音量（不除零）', captureLevel([], 0) === 0)

// 判定改成看「最响的那 100 毫秒」：一句话常常只占整段录音的一小截，平均会被前后的静音拖下水。
// makeTake 按毫秒攒样本，安静段与说话段分开摆——造出来的形态就是真实按住的形态。
const makeTake = (segments, rate = 16_000) => {
  const chunks = segments.map(({ ms, amp }) => new Float32Array(Math.round((rate * ms) / 1000)).fill(amp))
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0)
  return { chunks, frames, rate }
}
const wordInLongHold = makeTake([
  { ms: 1500, amp: 0.0005 },
  { ms: 200, amp: 0.02 },
  { ms: 300, amp: 0.0005 }
])
const holdRms = captureLevel(wordInLongHold.chunks, wordInLongHold.frames)
const holdPeak = capturePeak(wordInLongHold.chunks, wordInLongHold.frames, wordInLongHold.rate)
check(
  '录音闸：长按住只说了一个词也算说了（整段平均会被静音拖到阈值下）',
  holdRms < SILENCE_RMS && holdPeak > SILENCE_RMS && judgeCapture({ frames: wordInLongHold.frames, sampleRate: wordInLongHold.rate, rms: holdRms, peak: holdPeak }).ok,
  `mean=${holdRms.toFixed(5)} peak=${holdPeak.toFixed(5)}`
)
check(
  '录音闸：最响窗取的是峰值窗，不是整段平均',
  Math.abs(capturePeak([new Float32Array(16).fill(0.5)], 16, 16_000) - 0.5) < 1e-6 &&
    Math.abs(capturePeak([], 0, 16_000)) === 0
)
const dead = judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: 0, peak: 0 })
check(
  '录音闸：全零单独判成「设备没声音」，不再和「说话太轻」混成一句',
  dead.reason === 'no-signal' && dead.line !== judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: 0.004, peak: 0.006 }).line,
  dead.line
)
check(
  '录音闸：全零也要先看时长（误触还是误触）',
  judgeCapture({ frames: 1600, sampleRate: 16_000, rms: 0, peak: 0 }).reason === 'too-short'
)
check(
  '录音闸：有一点底噪但没人说话，仍算没检测到语音',
  judgeCapture({ frames: 16_000, sampleRate: 16_000, rms: 0.004, peak: 0.006 }).reason === 'silent'
)
check('麦租约：刚松开的流可以复用', canReuseMic(0, 'live'))
check('麦租约：租约内可以复用，到点就不能', canReuseMic(MIC_WARM_LEASE_MS - 1, 'live') && !canReuseMic(MIC_WARM_LEASE_MS, 'live'))
check('麦租约：设备拔了就不复用（ended）', !canReuseMic(0, 'ended') && !canReuseMic(0, undefined))
check('麦租约：时间倒流不当成新鲜', !canReuseMic(-1, 'live'))
// 设备没声音时把设备名摆到用户眼前：他要改的是系统输入，不是再喊一遍。
check(
  '录音闸：设备静音时那行带上设备名',
  rejectLine(dead, '麦克风阵列 (智音技术)') === `麦克风没有声音：检查输入设备（麦克风阵列 (智音技术)）`
)
check('录音闸：读不到设备名就不加空括号', rejectLine(dead, '') === dead.line)
check('录音闸：只是太轻时不提设备（说了等于没说）', rejectLine(hushed, '麦克风阵列') === hushed.line)

if (failed > 0) {
  console.log(`${failed} 条纯逻辑断言失败`)
  process.exit(1)
}
console.log('纯逻辑断言全部通过')
