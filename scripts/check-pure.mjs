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
import { readFileSync } from 'node:fs'
import { pureResolve } from './pure-resolve.mjs'

// 先装钩子再 import：`src/shared/` 的 import 不带扩展名，Node 解析器需要被补全一次。
registerHooks({ resolve: pureResolve })
const { gradeAsrCheck, gradeSpoken, summarizeAsrCheck } = await import('../src/shared/train/asr-check.ts')
const { formatCer, measureCer, normalizeSpoken, rankByCer, summarizeCer, summarizeCerByCohort } = await import('../src/shared/train/cer.ts')
const { FT_TARGET_STEPS, deriveFtEpochsFor, deriveFtResumeEpochs } = await import('../src/shared/train/asr-ft.ts')
const { DEVICE_ID_PLACEHOLDER, maskLogText, wantedLogFiles } = await import('../src/shared/log-bundle.ts')
const { filterHistory, historyCopyText } = await import('../src/shared/overlay-ledger.ts')
const { judgeDownloadFailure } = await import('../src/shared/download-failure.ts')
const {
  EMPTY_TALLY,
  CANDIDATE_LIMIT,
  mergePlan,
  parseTally,
  rankCandidates,
  recordCorrection,
  dismissCandidates,
  handledWords
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
  '热词候选：表满丢下的词不算已处理，要留在池子里（#138）',
  (() => {
    const full = Array.from({ length: 50 }, (_, i) => `词${i}`).join(',')
    const plan = mergePlan(full, ['泰坦', '词3'])
    const handled = handledWords(plan)
    return plan.dropped.includes('泰坦') && !handled.includes('泰坦') && handled.includes('词3')
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

// —— 诊断包脱敏（#111）：昵称与设备 id 换成占位，其余原样 ——
const maskedChat = maskLogText(
  ['{"name":"小明","text":"nice"}', '{"name":"红红","text":"gg"}', '{"name":"小明","text":"再来一把"}'].join('\n'),
  true
)
check(
  '诊断包：昵称按首次出现编号，同名同号',
  maskedChat.text.split('\n')[0].includes('"name":"玩家1"') &&
    maskedChat.text.split('\n')[1].includes('"name":"玩家2"') &&
    maskedChat.text.split('\n')[2].includes('"name":"玩家1"'),
  maskedChat.text.split('\n').join(' | ')
)
check('诊断包：原文昵称不在包里', !maskedChat.text.includes('小明') && !maskedChat.text.includes('红红'))
check(
  '诊断包：设备 id 变占位，设备名留着',
  (() => {
    const out = maskLogText('{"mic":"麦克风 (Realtek)|a1b2c3d4"}', true)
    return out.text === `{"mic":"麦克风 (Realtek)|${DEVICE_ID_PLACEHOLDER}"}` && !out.text.includes('a1b2c3d4')
  })()
)
check('诊断包：译文与句子不被动（只换身份键）', maskLogText('{"text":"打得不错","act":"idle"}', true).text === '{"text":"打得不错","act":"idle"}')
check('诊断包：没有身份字段的那份不算脱敏', !maskLogText('{"grabMs":18}', true).masked)
check('诊断包：显式关掉时原文保留', maskLogText('{"name":"小明"}', false).text === '{"name":"小明"}')
check(
  '诊断包：pretty JSON 的昵称也换掉，排版不动',
  (() => {
    const out = maskLogText('{\n  "name": "张三"\n}', true)
    return out.masked && !out.text.includes('张三') && out.text.includes('"name": "玩家1"') && out.text.includes('\n')
  })()
)
check(
  '诊断包：键名大小写不同也换',
  (() => {
    const out = maskLogText('{"Name":"王五"}', true)
    return out.masked && !out.text.includes('王五')
  })()
)
check(
  '诊断包：跨文件共用一张编号表，同一个人还是同一个号',
  (() => {
    const shared = new Map()
    return (
      maskLogText('{"name":"赵六"}', true, shared).text.includes('玩家1') &&
      maskLogText('{"nick":"赵六"}', true, shared).text.includes('玩家1')
    )
  })()
)
check(
  '诊断包：只收表里点名的文件，顺序按表',
  wantedLogFiles(['voice-chain.jsonl', 'nope.txt', 'inplace.log']).map((f) => f.name).join(',') ===
    'inplace.log,voice-chain.jsonl'
)

// —— 召唤面板历史过滤（ticket 116）：收窄只看词，复制永远给整行 ——
const HISTORY_ROWS = [
  { id: 'a', ts: 1, original: '[队友] [阿杰] ⚔ 中路miss', body: '中路miss', translated: null },
  { id: 'b', ts: 2, original: '[队友] [阿杰] ⚔ 买眼', body: '买眼', translated: 'ward' },
  { id: 'c', ts: 3, original: '[所有人] [Miracle] ⚔ gg wp', body: 'gg wp', translated: '打得好' }
]
check('历史过滤：空查询原样返回同一份数组', filterHistory(HISTORY_ROWS, '  ') === HISTORY_ROWS)
check(
  '历史过滤：昵称收窄到那个人的行',
  filterHistory(HISTORY_ROWS, '阿杰').map((row) => row.id).join(',') === 'a,b'
)
check(
  '历史过滤：关键词不分大小写且命中译文也算',
  filterHistory(HISTORY_ROWS, 'WARD').map((row) => row.id).join(',') === 'b'
)
check(
  '历史过滤：空格分词是都要命中',
  filterHistory(HISTORY_ROWS, '阿杰 买眼').map((row) => row.id).join(',') === 'b'
)
check('历史过滤：没命中就是空数组', filterHistory(HISTORY_ROWS, '查无此词').length === 0)
check(
  '历史过滤：复制的是整行（有译文抄译文，否则原文）',
  historyCopyText(HISTORY_ROWS[0]) === '[队友] [阿杰] ⚔ 中路miss' && historyCopyText(HISTORY_ROWS[1]) === 'ward'
)
// —— 机器体检（ticket 77）：状态配色、判据不动数字、设备数与端口 ——
const { judgeEnv, envCounted, envTroubled } = await import('../src/shared/env-report.ts')
const { machineCheckOffer, MACHINE_CHECK_LABEL } = await import('../src/shared/env-report.ts')
check('体检：内存偏紧是 warn 不是 bad', judgeEnv({ cpuModel: 'x', cpuCores: 8, freeMemBytes: 1024 ** 3, totalMemBytes: 8000 * 1024 ** 2, diskFreeBytes: 20 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3, diskPath: 'D:', gsiPort: 32123, portOwner: 'ours', micCount: 1, speakerCount: 1 }).rows.find((r) => r.id === 'memory').state === 'warn')
check('体检：磁盘偏紧是 warn 不是 bad', judgeEnv({ cpuModel: 'x', cpuCores: 8, freeMemBytes: 8 * 1024 ** 3, totalMemBytes: 16 * 1024 ** 3, diskFreeBytes: 3 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3, diskPath: 'D:', gsiPort: 32123, portOwner: 'ours', micCount: 1, speakerCount: 1 }).rows.find((r) => r.id === 'disk').state === 'warn')
check('体检：端口被别人占是 bad，空着是 warn，本应用是 ok', (() => { const mk = (portOwner) => judgeEnv({ cpuModel: 'x', cpuCores: 8, freeMemBytes: 8 * 1024 ** 3, totalMemBytes: 16 * 1024 ** 3, diskFreeBytes: 20 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3, diskPath: 'D:', gsiPort: 32123, portOwner, micCount: 1, speakerCount: 1 }).rows.find((r) => r.id === 'port').state; return mk('other') === 'bad' && mk('free') === 'warn' && mk('ours') === 'ok' })())
check('体检：counted 只数有数据的行，troubled 只数偏紧/有问题', (() => { const rep = judgeEnv({ cpuModel: 'x', cpuCores: 8, freeMemBytes: 1024 ** 3, totalMemBytes: 8000 * 1024 ** 2, diskFreeBytes: 20 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3, diskPath: 'D:', gsiPort: 32123, portOwner: null, micCount: null, speakerCount: 1 }); const mem = rep.rows.find((r) => r.id === 'memory'); const port = rep.rows.find((r) => r.id === 'port'); const mic = rep.rows.find((r) => r.id === 'mic'); return envCounted(rep) === 4 && envTroubled(rep).length === 1 && envTroubled(rep)[0].id === 'memory' && envCounted({ at: '', rows: [mem, port, mic] }) === 1 })())
check('体检：设备 0 个是 warn（会录到静音），null 是 unknown 且带原因', (() => { const rep = judgeEnv({ cpuModel: 'x', cpuCores: 8, freeMemBytes: 8 * 1024 ** 3, totalMemBytes: 16 * 1024 ** 3, diskFreeBytes: 20 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3, diskPath: 'D:', gsiPort: 32123, portOwner: 'ours', micCount: 0, speakerCount: null }).rows; return rep.find((r) => r.id === 'mic').state === 'warn' && rep.find((r) => r.id === 'speaker').state === 'unknown' && rep.find((r) => r.id === 'speaker').gap !== null })())

// —— 数据体检（dataset-health）：重复/录不出话/缺句三类，判据不许在别处再写一遍 ——
const { HEALTH_KEYS_SHOWN, healthLine, judgeDatasetHealth } = await import('../src/shared/train/dataset-health.ts')
const HEALTH_TAKES = [
  { key: 'G01-L01', text: '中路 miss', frames: 16_000, sampleRate: 16_000, rms: 0.2, peak: 0.4 },
  { key: 'G01-L02', text: '中路  miss ', frames: 16_000, sampleRate: 16_000, rms: 0.2, peak: 0.4 },
  { key: 'G01-L03', text: '撤退', frames: 16_000, sampleRate: 16_000, rms: 0, peak: 0 }
]
const healthDirty = judgeDatasetHealth({ takes: HEALTH_TAKES, expected: ['G01-L01', 'G01-L02', 'G01-L03', 'G01-L04'] })
check(
  '数据体检：重复 + 静音 + 缺句正好报三类，顺序固定',
  healthDirty.issues.map((issue) => issue.kind).join(',') === 'duplicate,unusable,missing',
  healthDirty.issues.map((issue) => issue.kind).join(',')
)
check('数据体检：空白与大小写不把同一句算成两句', healthDirty.issues[0].keys.join(',') === 'G01-L01,G01-L02')
check('数据体检：全零录音算「录不出话」而不是缺句', healthDirty.issues[1].keys.join(',') === 'G01-L03')
check('数据体检：缺句只点名稿子里没录的那条', healthDirty.issues[2].keys.join(',') === 'G01-L04')
check(
  '数据体检：干净目录一条都不报',
  judgeDatasetHealth({ takes: HEALTH_TAKES.slice(0, 1), expected: ['G01-L01'] }).ok
)
check(
  `数据体检：缺句点名上限 ${HEALTH_KEYS_SHOWN} 条，计数仍是准数`,
  (() => {
    const many = judgeDatasetHealth({
      takes: [],
      expected: Array.from({ length: 20 }, (_, index) => `G09-L${String(index + 1).padStart(2, '0')}`)
    })
    return many.issues[0].keys.length === HEALTH_KEYS_SHOWN && many.issues[0].label.includes('20 句')
  })()
)
check(
  '数据体检：时长分布是四条（最短/中位/最长/合计）',
  (() => {
    const health = judgeDatasetHealth({ takes: HEALTH_TAKES, expected: ['G01-L01'] })
    return (
      health.duration.minMs === 1000 &&
      health.duration.medianMs === 1000 &&
      health.duration.maxMs === 1000 &&
      health.duration.totalMs === 3000
    )
  })()
)
check(
  '数据体检：面板那一行没问题时说清条目与时长',
  healthLine(judgeDatasetHealth({ takes: HEALTH_TAKES.slice(0, 1), expected: ['G01-L01'] })) ===
    '1 条 · 共 1 秒 · 没有重复/静音/缺句'
)

// —— 关键名词（key-nouns）：翻译前抽清单、翻译后只核对，缺了标一次且不改译文 ——
const { flagKeyNouns, keyNounsOf } = await import('../src/shared/key-nouns.ts')
const mjollnirNouns = keyNounsOf('need mjollnir top', 'auto-zh')
check(
  '关键名词：翻译前抽清单只认英雄/物品全名，术语不进清单',
  mjollnirNouns.map((noun) => noun.zh).join(',') === '雷锤' && keyNounsOf('push mid now', 'auto-zh').length === 0,
  mjollnirNouns.map((noun) => noun.zh).join(',')
)
const lostNoun = flagKeyNouns(mjollnirNouns, '需要上路')
check('关键名词：译文丢掉物品名就标一次', lostNoun.keyNouns.join(',') === '雷锤', lostNoun.keyNouns.join(','))
check('关键名词：标记不改译文（原文一字不差）', lostNoun.text === '需要上路', lostNoun.text)
check('关键名词：干净的译文一条都不标', flagKeyNouns(mjollnirNouns, '需要雷锤上路').keyNouns.length === 0)
check('关键名词：英文原名留在译文里也算没丢', flagKeyNouns(mjollnirNouns, 'mjollnir 上路').keyNouns.length === 0)
check(
  '关键名词：zh-en 方向按中文侧点名',
  flagKeyNouns(keyNounsOf('雷锤还没出', 'zh-en'), 'not ready').keyNouns.join(',') === '雷锤',
  flagKeyNouns(keyNounsOf('雷锤还没出', 'zh-en'), 'not ready').keyNouns.join(',')
)
check('关键名词：词边界内的假命中不算（tinyhouse ≠ tiny）', keyNounsOf('tinyhouse next door', 'auto-zh').length === 0)

// —— 逐行判方向（translate-direction）：汉字占比定方向，手工更正只改这一句 ——
const { correctDirection, detectDirection, directionFor, directionLabel, directionOverrideCount, forgetDirections, hanShare } =
  await import('../src/shared/translate-direction.ts')
check('方向：纯中文中→英、纯英文英→中', detectDirection('中路不见了') === 'zh-en' && detectDirection('where is the courier') === 'en-zh')
check('方向：中英混排按汉字占比，夹一个中文词就是中文行', detectDirection('push 中路') === 'zh-en' && detectDirection('where is the 肉山') === 'en-zh')
check('方向：数字与标点不进分母', detectDirection('GG 666') === 'en-zh' && hanShare('？！…') === 0)
forgetDirections()
correctDirection('need mjollnir', 'zh-en')
check(
  '方向：更正记住这一句，空白与大小写不影响',
  directionFor('need mjollnir') === 'zh-en' && directionFor('  Need   Mjollnir ') === 'zh-en' && directionOverrideCount() === 1
)
check('方向：别的句子不受更正影响', directionFor('where is the courier') === 'en-zh')
correctDirection('need mjollnir', 'en-zh')
check('方向：更正回原来的方向就等于撤销', directionOverrideCount() === 0)
forgetDirections()
check('方向：方向标写中→英 / 英→中', directionLabel('zh-en') === '中→英' && directionLabel('en-zh') === '英→中')

// —— 周度质量卡（quality-report）：守卫按行数、记账本取最新一行，文案不许暗示漏检率 ——
const { qualityReportOf, guardLine, cacheLine, qualityFootnote, parseCacheSnapshot, summarizeCacheSnapshots } = await import(
  '../src/shared/quality-report.ts'
)
const guarded = qualityReportOf({
  guardText: [
    { at: '2026-01-01T00:00:01.000Z', via: 'session', direction: 'en-zh', tokens: ['bkb'], retryTokens: [], outcome: 'recovered' },
    { at: '2026-01-01T00:00:02.000Z', via: 'direct', direction: 'zh-en', tokens: ['gank'], retryTokens: ['gank'], outcome: 'gaveup' }
  ]
    .map((row) => JSON.stringify(row))
    .join('\n'),
  cacheText: [
    { at: '2026-01-01T00:00:00.000Z', pairs: 10, lifetimeHits: 40, hitRatio: 0.8, sessionHits: 2, sessionMisses: 2 },
    { at: '2026-01-01T00:01:00.000Z', pairs: 16, lifetimeHits: 64, hitRatio: 0.8, sessionHits: 9, sessionMisses: 3 }
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')
})
check('质量卡：空日志给 0，不抛也不返回 null', qualityReportOf({}).guard.caught === 0 && qualityReportOf({}).cache.snapshots === 0)
check('质量卡：守卫按行数算拦下、救回、退回原文', guarded.guard.caught === 2 && guarded.guard.recovered === 1 && guarded.guard.gaveUp === 1)
check('质量卡：记账本取最新一行的累计与本次运行', guarded.cache.pairs === 16 && guarded.cache.sessionHits === 9 && guarded.cache.sessionMisses === 3)
check('质量卡：命中占比 = 9/(9+3)', guarded.cache.sessionRatio === 0.75)
check('质量卡：半截行与非对象整行丢掉', parseCacheSnapshot('{"pairs":3') === null && parseCacheSnapshot('42') === null)
check('质量卡：没有快照时占比给 0 而不是 NaN', summarizeCacheSnapshots([]).sessionRatio === 0)
check('质量卡：守卫文案不带百分号也不含「率」', !guardLine(guarded.guard).includes('%') && !guardLine(guarded.guard).includes('率'))
check('质量卡：守卫文案照实写次数', guardLine(guarded.guard) === '拦下 2 次 · 救回 1 次 · 退回原文 1 次')
check('质量卡：记账本文案写命中占比', cacheLine(guarded.cache) === '本次运行白拿 9 次 · 现翻 3 次 · 命中占比 75%')
check('质量卡：小字写累计与快照次数', qualityFootnote(guarded.cache).includes('16 对') && qualityFootnote(guarded.cache).includes('2 次快照'))
// —— Steam 库选择（gsi-lib）：选了就只认那个库，库没了报缺失而不是偷偷换库（#78） ——
const { libraryLabel, resolveGsiRoot } = await import('../src/shared/gsi-lib.ts')
const twoLibs = [
  { root: 'C:\\Steam', hasDota: true },
  { root: 'D:\\SteamLibrary', hasDota: true }
]
check(
  'Steam 库：选了第二个库就写第二个库',
  resolveGsiRoot(twoLibs, 'D:\\SteamLibrary').root === 'D:\\SteamLibrary' &&
    resolveGsiRoot(twoLibs, 'D:\\SteamLibrary').auto === false
)
check(
  'Steam 库：选的库不在了报缺失，不退回自动',
  resolveGsiRoot(twoLibs, 'E:\\Moved').root === null && resolveGsiRoot(twoLibs, 'E:\\Moved').missing === true
)
check('Steam 库：没选过就自动挑第一个装了 Dota 的', resolveGsiRoot(twoLibs, '').root === 'C:\\Steam')
check(
  'Steam 库：选了没装 Dota 的库也算缺失',
  resolveGsiRoot([...twoLibs.slice(0, 1), { root: 'D:\\SteamLibrary', hasDota: false }], 'D:\\SteamLibrary').missing === true
)
check(
  'Steam 库：一个装 Dota 的都没有时落点为 null',
  resolveGsiRoot([{ root: 'D:\\SteamLibrary', hasDota: false }], '').root === null
)
check('Steam 库：展示名标出「没装 Dota」', libraryLabel({ root: 'D:\\SteamLibrary', hasDota: false }).includes('没装 Dota'))

// —— 对讲三态环（voice-ring）：形状区分状态，录音压过朗读（#94） ——
const { voiceRingState, voiceRingView } = await import('../src/shared/voice-ring.ts')
const idleRing = voiceRingView({ recording: false, speaking: false })
const recordingRing = voiceRingView({ recording: true, speaking: false })
const speakingRing = voiceRingView({ recording: false, speaking: true })
const bothRing = voiceRingView({ recording: true, speaking: true })
check('三态环：空闲/录音/朗读各自成态', idleRing.state === 'idle' && recordingRing.state === 'recording' && speakingRing.state === 'speaking')
check(
  '三态环：形状三者互不相同（灰度截图也分得清）',
  new Set([idleRing.shape, recordingRing.shape, speakingRing.shape]).size === 3
)
check('三态环：标签各不相同', new Set([idleRing.label, recordingRing.label, speakingRing.label]).size === 3)
check('三态环：录音时同时也在朗读，显示录音（按着热键最要紧的是「我在被录」）', bothRing.state === 'recording' && voiceRingState({ recording: true, speaking: true }) === 'recording')
check('三态环：只有录音与朗读会动，空闲不动', idleRing.pulse === false && recordingRing.pulse && speakingRing.pulse)
check('三态环：朗读态读屏文案说「正在朗读」，不说「已恢复」', speakingRing.aria.includes('正在朗读') && !/已恢复|已修复/.test(speakingRing.aria))

// —— 语音队列（#88）：面板只画主进程给的快照，文案由纯函数出 ——
const { queueLine, stopLine } = await import('../src/shared/speech-queue.ts')
check('队列文案：空闲就说空闲', queueLine({ speaking: null, pending: 0, lanes: [] }) === '空闲')
check(
  '队列文案：正在读并报余量',
  queueLine({ speaking: '你走中路,我下路', pending: 2, lanes: [] }) === '正在读「你走中路,我下路」 · 余 2 句'
)
check('队列文案：只排队没在说', queueLine({ speaking: null, pending: 3, lanes: [] }) === '余 3 句待读')
check('停止回执：边读边清', stopLine({ cleared: 2, interrupted: true }) === '这句读到段尾 · 清掉 2 句排队')
check('停止回执：什么都没在说', stopLine({ cleared: 0, interrupted: false }) === '本来就没在说')

// —— 麦克风健康（#96）：掉线判定、无帧不进链、电平换算 ——
const { levelPercent, micDead, micDeadNotice, shouldRunChain } = await import('../src/shared/mic-health.ts')
check('麦克风：轨道 ended 判为坏', micDead({ readyState: 'ended', muted: false }))
check('麦克风：被系统静音也判为坏', micDead({ readyState: 'live', muted: true }))
check('麦克风：活的且没静音放行', !micDead({ readyState: 'live', muted: false }))
check('麦克风：掉线提示带设备名、说清没声音', micDeadNotice('麦克风阵列 (Realtek)').includes('麦克风阵列') && micDeadNotice('').includes('没声音'))
check('链路门：0 帧永远不进 ASR（判成立也不进）', !shouldRunChain({ ok: true, frames: 0 }) && !shouldRunChain({ ok: false, frames: 24_000 }))
check('链路门：有帧且判定成立才进', shouldRunChain({ ok: true, frames: 24_000 }))
check('电平：0/负数/NaN 都是 0，0.1 顶满', levelPercent(0) === 0 && levelPercent(-3) === 0 && levelPercent(Number.NaN) === 0 && levelPercent(0.4) === 100)
check('电平：说话量级落在六成上下', levelPercent(0.05) >= 55 && levelPercent(0.05) <= 65)
// —— 按住自检（#95）：状态与文案是用户可以据以判断「按住还灵不灵」的唯一证据
const { formatHeld, judgeHoldHealth, summarizeHoldEdges } = await import('../src/shared/hold-selftest.ts')
const holdBase = { presence: 'resident', ready: true, attempts: 0, fallbackReason: null, edges: [] }
const held = summarizeHoldEdges([
  { at: 1_000, kind: 'press' },
  { at: 1_820, kind: 'release' },
  { at: 5_000, kind: 'press' }
])
check('按住自检：一按一放算一对，按住时长 820ms', held.presses === 2 && held.releases === 1 && held.pairs === 1 && held.heldMs === 820)
check('按住自检：只按着没松开时不会有配对的时长', held.heldMs !== null && summarizeHoldEdges([{ at: 1, kind: 'press' }]).heldMs === null)
check('按住自检：仍常驻且收到过边 → 正常态', judgeHoldHealth({ ...holdBase, edges: [{ at: 1, kind: 'press' }] }).tone === 'ready')
check('按住自检：常驻但一次没按过 → 提醒，不算正常', judgeHoldHealth(holdBase).tone === 'warn')
check(
  '按住自检：退回敲一下是坏的，必须说清按住已失效',
  (() => {
    const view = judgeHoldHealth({ ...holdBase, presence: 'fallback', ready: false, fallbackReason: '常驻脚本连续 5 次没起来' })
    return view.tone === 'bad' && view.title.includes('退回') && view.hint.includes('按一下')
  })()
)
check(
  '按住自检：任何状态都不许说「已恢复」这类假话',
  ['off', 'starting', 'resident', 'fallback'].every((presence) => {
    const view = judgeHoldHealth({ ...holdBase, presence, ready: presence === 'resident', fallbackReason: null })
    return !/已恢复|已修复|recovered|repaired/.test(`${view.title}${view.hint}`)
  })
)
check('按住自检：时长文案毫秒/秒分档', formatHeld(320) === '320 ms' && formatHeld(1_820) === '1.8 s' && formatHeld(12_400) === '12 s')

// —— 战况摘要（#99）：只搬已有行里的话，排序按意图强弱 ——
const { digestCues, digestLine, digestRowText } = await import('../src/shared/overlay-digest.ts')
const digestRows = ['gg', 'mid is missing', 'need 4 top', 'nice'].map((s) => ({ id: s, original: s, translated: null }))
const digestRowLine = digestLine(digestRows)
check('摘要每一段都出自已存在的行（不编造）', digestRowLine.split(' +')[0].split(' · ').every((part) => digestRows.some((r) => r.original.startsWith(part.replace(/…$/, '')))))
check('摘要说清被省掉的句数', digestRowLine.includes(' +') && Number(digestRowLine.slice(digestRowLine.lastIndexOf('+') + 1)) > 0)
check('意图明显的行都在摘要里', digestRowLine.includes('mid is missing') && digestRowLine.includes('need 4 top'))
check('命中一样多时后说的在前', digestRowLine.indexOf('need 4 top') < digestRowLine.indexOf('mid is missing'))
check('有译文用译文、没译文用原文', digestRowText({ id: 'a', original: '需要 tp', translated: 'need tp' }) === 'need tp' && digestRowText({ id: 'b', original: '需要 tp', translated: null }) === '需要 tp')
check('空列表给空串（浮层不画空壳）', digestLine([]) === '' && digestLine([{ id: 'x', original: '  ', translated: null }]) === '')
check('意图词表能数命中', digestCues('mid is missing') >= 1 && digestCues('gg') === 0)
check('同一批消息两次摘要一致', digestLine(digestRows) === digestRowLine)
// —— 下载失败是谁的错（#79）：换镜像能不能救，全看这一句 ——
check(
  '下载失败：连接被掐算网络',
  judgeDownloadFailure('TypeError: fetch failed').kind === 'network' &&
    judgeDownloadFailure('stall: no bytes for 60s').kind === 'network' &&
    judgeDownloadFailure('net::ERR_CONTENT_LENGTH_MISMATCH').kind === 'network'
)
check(
  '下载失败：状态码与尺寸不符算源站',
  judgeDownloadFailure('HTTP 404').kind === 'source' && judgeDownloadFailure('size mismatch: 100/200').kind === 'source'
)
check(
  '下载失败：文案里带得出「网络」「源站」两个字',
  judgeDownloadFailure('fetch failed').text.startsWith('网络：') &&
    judgeDownloadFailure('HTTP 500').text.startsWith('源站：') &&
    judgeDownloadFailure('').text === '原因不明：未知错误'
)

// —— 对局播报（#123）：只信游戏时钟与帧里的事实，同一件事只报一次 ——
const { initialAnnounceState, stepAnnounces, DEFAULT_ANNOUNCE_TRIGGERS } = await import('../src/shared/dota-announce.ts')
const announceTick = (state, seconds, matchId = 42) =>
  seconds.flatMap((s) => stepAnnounces(state, { gameTime: s, matchId: String(matchId) }))
const announceIds = (state, seconds) => announceTick(state, seconds).map((e) => e.id)
const freshState = initialAnnounceState
check('智慧符在 7:00 报一次，重复帧不报', announceIds(freshState(), [420, 420, 421]).filter((id) => id === 'wisdom').length === 1)
check('智慧符 14:00 再报一次（每枚一次）', announceIds(freshState(), [420, 840]).filter((id) => id === 'wisdom').length === 2)
check('堆野窗口 :53 报、:56 不报', announceIds(freshState(), [233, 236]).filter((id) => id === 'stack').length === 1)
check('拉野 :15 与 :45 各报一次', announceIds(freshState(), [375, 405]).filter((id) => id === 'pull').length === 2)
check('没有 roshan 块就不报肉山', announceTick(freshState(), [1080]).every((e) => e.id !== 'rosh'))
check('肉山死时间 +8 分钟才报、之前不报', (() => { const s = freshState(); const rosh = (g) => stepAnnounces(s, { gameTime: g, matchId: '42', roshan: { state: 'dead', death_time: 600 } }).filter((e) => e.id === 'rosh'); return rosh(1079).length === 0 && rosh(1080).length === 1 })())
check('没开闸时没人念（纯层只判该不该报，念不念由上层）', DEFAULT_ANNOUNCE_TRIGGERS.wisdom === true && typeof stepAnnounces === 'function')

// —— 词表包（#82）：坏包整包拒绝并说清哪一条坏了，回退文案不静默 ——
const { parseGlossaryPack, bundledGlossaryStatus, glossaryStatusOf, glossaryPackLine } = await import('../src/shared/glossary-pack.ts')
const packOk = parseGlossaryPack({
  name: '演示词表',
  entries: [
    { en: 'New Hero', zh: '新英雄', kind: 'hero' },
    { en: 'ww', zh: '怪杖', kind: 'item', keepVerbatim: true },
    { en: 'New Hero', zh: '新英雄', kind: 'hero' }
  ]
})
check(
  '合法包通过校验，重复 en 只留第一条',
  packOk.ok && packOk.pack.name === '演示词表' && packOk.pack.entries.length === 2 && packOk.pack.entries[1].keepVerbatim === true
)
const packNoName = parseGlossaryPack({ entries: [{ en: 'x', zh: '叉', kind: 'item' }] })
check('缺 name 被拒并说 name', packNoName.ok === false && packNoName.error.includes('name'))
const packBadKind = parseGlossaryPack({ name: '坏', entries: [{ en: 'x', zh: '叉', kind: 'spell' }] })
check('kind 越界被拒并点名第 1 条', packBadKind.ok === false && packBadKind.error.includes('第 1 条') && packBadKind.error.includes('kind'))
check('没有包时面板文案说清去哪里放', glossaryPackLine(bundledGlossaryStatus()).includes('还没有词表包'))
check(
  '坏包的面板文案同时说回退与原因',
  glossaryPackLine(bundledGlossaryStatus('坏了', ['坏包'], '坏包.json')).includes('已回退内置')
)
check(
  '装上的面板文案说出包名与条数',
  packOk.ok && glossaryStatusOf(packOk.pack, '演示词表.json', ['演示词表']).name === '演示词表' && glossaryPackLine(glossaryStatusOf(packOk.pack)).includes('演示词表')
)


// —— 短句/长句分流（asr-routing）：短走快、长走准、可关、带原因 ——
{
  const { routeAsrClip, routingLine, routingLogRecord, ASR_ROUTE_SHORT_ENGINE, ASR_ROUTE_LONG_ENGINE } = await import('../src/shared/asr-routing.ts')
  const base = { ruleOn: true, shortReady: true, longReady: true }
  const short = routeAsrClip({ ...base, durationMs: 1000, activeEngine: 'qwen3' })
  check('短句走 paraformer 且切换', short.engine === ASR_ROUTE_SHORT_ENGINE && short.switched && short.reason === 'short', `${short.engine}/${short.reason}`)
  const long = routeAsrClip({ ...base, durationMs: 5000, activeEngine: 'paraformer' })
  check('长句走 qwen3 且切换', long.engine === ASR_ROUTE_LONG_ENGINE && long.switched && long.reason === 'long', `${long.engine}/${long.reason}`)
  const off = routeAsrClip({ ...base, ruleOn: false, activeEngine: 'qwen3' })
  check('规则关着回单引擎', off.engine === 'qwen3' && !off.switched && off.reason === 'rule-off', off.reason)
  const missing = routeAsrClip({ ...base, durationMs: 1000, activeEngine: 'qwen3', shortReady: false })
  check('目标没装好留现役', missing.engine === 'qwen3' && !missing.switched && missing.reason === 'target-missing', missing.reason)
  const odd = routeAsrClip({ ...base, activeEngine: 'qwen3-other' })
  check('现役不在这对里不插手', odd.engine === 'qwen3-other' && !odd.switched && odd.reason === 'not-a-pair', odd.reason)
  check('routingLine 说清原因', routingLine(short, 'qwen3').includes('短句走快引擎'), routingLine(short, 'qwen3'))
  const rec = routingLogRecord(short, 'qwen3')
  check('日志记录字段齐全', rec.from === 'qwen3' && rec.to === ASR_ROUTE_SHORT_ENGINE && rec.reason === 'short' && typeof rec.note === 'string', JSON.stringify(rec))
}

// —— 试听对比（#105）：同一批留出集录音在两副模型上的并排结果 ——
{
  const { judgeAudition, auditionLine, auditionSkipLine, AUDITION_MAX_ROWS } = await import('../src/shared/train/audition.ts')
  const pairs = [
    { key: 'G14-L01', expected: '中路不见了', before: '中路不见', after: '中路不见了' },
    { key: 'G14-L02', expected: '肉山要打了', before: '肉山要打了', after: '肉山要打了' },
    { key: 'G14-L03', expected: '撤退', before: '', after: '撤退' }
  ]
  const audition = judgeAudition(pairs, 1700000000000)
  check('逐句胜负与 CER 一致', audition.rows.every((row) => (row.beforeCer === row.afterCer ? row.better === 'same' : row.better === (row.afterCer < row.beforeCer ? 'after' : 'before'))), JSON.stringify(audition.rows.map((row) => [row.key, row.better])))
  check('整批结论与 CER 同向', audition.verdict === 'better' && audition.beforeCer > audition.afterCer, `${audition.beforeCer}->${audition.afterCer}`)
  check('空识别按全错算', audition.rows.find((row) => row.key === 'G14-L03').beforeCer === 1, 'expect 1')
  check('句数统计等于输入句数', audition.count === pairs.length && audition.better + audition.worse + audition.same === pairs.length, `${audition.count}`)
  const many = Array.from({ length: AUDITION_MAX_ROWS + 3 }, (_unused, index) => ({ key: `K${index}`, expected: '好', before: index === 0 ? '坏' : '好', after: '好' }))
  const capped = judgeAudition(many, 1)
  check('表格截断且差异句优先', capped.rows.length === AUDITION_MAX_ROWS && capped.rows[0].key === 'K0', `${capped.rows.length}/${capped.rows[0]?.key}`)
  check('对比一句话带句数与 CER', auditionLine(audition).includes('3 句') && auditionLine(audition).includes('CER'), auditionLine(audition))
  check('自动跳过与人点的分开说', auditionSkipLine({ at: 1, auto: true, reason: '没有留出集可听' }).startsWith('自动跳过') && auditionSkipLine({ at: 1, auto: false, reason: '' }) === '跳过试听', auditionSkipLine({ at: 1, auto: true, reason: '没有留出集可听' }))
  const { buildTrainRun, finishTrainRun } = await import('../src/shared/train/run.ts')
  const run = buildTrainRun({ kind: 'asr-ft', experiment: 'ft-pure', startedAt: 1700000000000 })
  const patched = finishTrainRun(run, { status: 'trained', audition, auditionSkip: { at: 1, auto: false, reason: '' } })
  check('run 行默认没有试听记录、收场能落两条', run.audition === null && run.auditionSkip === null && patched.audition?.count === 3 && patched.auditionSkip?.auto === false, `${patched.audition?.count}/${patched.auditionSkip?.auto}`)
}

// —— 补丁巡检（#131）：我们和游戏对不上的地方，三种比对各自只在该报的时候报 ——
{
  const { collectFramePaths, judgePatchWatch, patchWatchLine, unseenGaps, patchGapKey, heroKey, glossaryHasHero, GSI_READ_PATHS, PATCH_WATCH_MIN_FRAMES } = await import('../src/shared/patch-watch.ts')
  const frame = {
    provider: { name: 'Dota 2', appid: 570 },
    map: { name: 'start', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '1' },
    player: { name: 'me' },
    events: [{ event_type: 'chat_message' }],
    allplayers: { '0': { name: 'me', hero: 'npc_dota_hero_storm_spirit' } }
  }
  const paths = collectFramePaths(frame)
  check('一帧的路径把对象下探一层、数组记成 k[]', paths.includes('map.matchid') && paths.includes('events[]') && paths.includes('allplayers[].hero'), paths.slice(0, 4).join(','))
  // 健康帧只看「有没有多出来的」：采样不足一窗时不判 missing（那一条另有用例）。
  const healthy = { paths, heroes: ['storm_spirit'], eventTypes: ['chat_message'], frames: 1 }
  check('健康帧零缺口', judgePatchWatch(healthy, ['Storm Spirit']).length === 0, 'expect 0')
  const unread = judgePatchWatch({ ...healthy, paths: [...paths, 'map.clock_time'] }, ['Storm Spirit'])
  check('多出来的字段被点名', unread.length === 1 && unread[0].name === 'map.clock_time' && unread[0].kind === 'field-unread', JSON.stringify(unread.map((gap) => gap.name)))
  check('采样不够就不判 missing', judgePatchWatch({ ...healthy, frames: 1, paths: ['map.matchid'] }, ['Storm Spirit']).every((gap) => gap.kind !== 'field-missing'), 'expect none')
  const missing = judgePatchWatch({ ...healthy, frames: PATCH_WATCH_MIN_FRAMES, paths: ['map.matchid', 'player.name'] }, ['Storm Spirit']).filter((gap) => gap.kind === 'field-missing')
  check('采样够了才点名漏掉的必推字段', missing.some((gap) => gap.name === 'map.name') && !missing.some((gap) => gap.name === 'map.matchid' || gap.name === 'draft' || gap.name === 'roshan.state'), missing.map((gap) => gap.name).slice(0, 3).join(','))
  check('词表缺英雄被点名', judgePatchWatch({ ...healthy, heroes: ['muerta'] }, ['Storm Spirit']).some((gap) => gap.kind === 'hero' && gap.name === 'muerta'), 'expect muerta')
  check('id 与展示名不同形不算缺口', glossaryHasHero('nevermore', ['Shadow Fiend']) && heroKey('Anti-Mage') === 'antimage', 'expect alias')
  check('新事件类型被点名', judgePatchWatch({ ...healthy, eventTypes: ['chat_message', 'hero_pick'] }, ['Storm Spirit']).some((gap) => gap.kind === 'event-type' && gap.name === 'hero_pick'), 'expect hero_pick')
  const one = { kind: 'field-unread', name: 'map.clock_time', detail: '' }
  check('记过的缺口不再报', unseenGaps([one], [patchGapKey(one)]).length === 0 && unseenGaps([one], []).length === 1, patchGapKey(one))
  check('面板一句话点到名字', patchWatchLine([one]) === '游戏里出现了我们还不认识的：map.clock_time' && patchWatchLine([]) === '和游戏对得上', patchWatchLine([one]))
  check('声明表覆盖每个 payload 块', ['provider', 'map', 'player', 'events', 'allplayers', 'hero', 'draft', 'roshan'].every((block) => GSI_READ_PATHS.some((path) => path === block || path.startsWith(block + '.') || path.startsWith(block + '[]'))), GSI_READ_PATHS.length + ' 条')
}
// —— 浮层可读性（#100）：每一对文字 ≥ AA、三档字号装在最小窗口里、状态不只靠颜色 ——
{
  const {
    AA_NORMAL,
    OVERLAY_FONT_MAX_RATIO,
    OVERLAY_FONT_SIZES,
    OVERLAY_MIN_CHARS_PER_LINE,
    contrastRatio,
    judgeOverlayContrast,
    judgeOverlayFontSteps,
    judgeStateMarks,
    normalizeOverlayFontSize,
    overlayFontScale
  } = await import('../src/shared/overlay-a11y.ts')
  const contrast = judgeOverlayContrast()
  check('浮层每一对文字对比度 ≥ AA', contrast.failures.length === 0, contrast.failures.join('；') || `${contrast.pairs.length} 对`)
  check('最差的一对也 ≥ AA', contrast.worst.ratio >= AA_NORMAL, `${contrast.worst.token} ${contrast.worst.ratio}:1`)
  check('黑白对比度 21、同色 1', contrastRatio('#ffffff', '#000000') === 21 && contrastRatio('#808080', '#808080') === 1)
  const steps = judgeOverlayFontSteps()
  check('三档字号都装在最小窗口里', steps.failures.length === 0, steps.failures.join('；') || '小/标准/大')
  check(
    '字号单调递增且放大不超上限',
    OVERLAY_FONT_SIZES.map((size) => overlayFontScale(size).title).every((v, i, all) => i === 0 || v > all[i - 1]) &&
      steps.steps.every((step) => step.growth <= OVERLAY_FONT_MAX_RATIO),
    steps.steps.map((step) => `${step.size}:${step.scale.title}px`).join(' ')
  )
  check(
    '每档一行至少 12 个字',
    steps.steps.every((step) => step.charsPerLine >= OVERLAY_MIN_CHARS_PER_LINE),
    steps.steps.map((step) => `${step.size}:${step.charsPerLine}`).join(' ')
  )
  check('字号脏值回落 normal', normalizeOverlayFontSize('huge') === 'normal' && normalizeOverlayFontSize(12) === 'normal')
  check('每个有颜色的状态都有颜色以外的标记', judgeStateMarks().failures.length === 0)

  // CSS 与像素表漂移：overlay.css 里不许再有字面量 font-size，变量值必须与 overlayFontScale 一致。
  const css = readFileSync(new URL('../src/renderer/src/overlay/overlay.css', import.meta.url), 'utf8')
  const literal = /font-size:\s*[\d.]+px/.test(css)
  check('overlay.css 不再有字面量 font-size', !literal)
  const declared = [...css.matchAll(/--ov-fs-(mini|small|body|title):\s*([\d.]+)px/g)].map((hit) => [hit[1], Number(hit[2])])
  const normalCss = declared.slice(0, 4)
  const smallCss = declared.slice(4, 8)
  const largeCss = declared.slice(8, 12)
  const same = (rows, scale) =>
    rows.length === 4 && rows.every(([key, value]) => scale[key] === value)
  check(
    'overlay.css 的三档像素与 overlay-a11y 一致',
    same(normalCss, overlayFontScale('normal')) && same(smallCss, overlayFontScale('small')) && same(largeCss, overlayFontScale('large')),
    `${normalCss.length}/${smallCss.length}/${largeCss.length}`
  )
}

// —— 小地图血点（#134）：判据、连通域、面积门槛 ——
{
  const { DEFAULT_DOT_RULES, detectDots, isGreenPixel, isRedPixel } = await import('../src/shared/minimap.ts')
  check('英雄红被判成红', isRedPixel(212, 58, 50) && !isRedPixel(120, 90, 80), 'r212')
  check('队友绿被判成绿', isGreenPixel(80, 190, 90) && !isGreenPixel(120, 120, 90), 'g190')
  const size = 64
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = 24
    rgba[i * 4 + 1] = 32
    rgba[i * 4 + 2] = 22
    rgba[i * 4 + 3] = 255
  }
  const paint = (x0, y0, w, h, rgb) => {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const at = (y * size + x) * 4
        rgba[at] = rgb[0]
        rgba[at + 1] = rgb[1]
        rgba[at + 2] = rgb[2]
      }
    }
  }
  paint(10, 10, 6, 6, [212, 58, 50])
  paint(40, 40, 5, 5, [212, 58, 50])
  paint(2, 2, 1, 1, [212, 58, 50])
  const red = detectDots(rgba, size, size, 'red')
  check('两块红点、1 像素噪声被门槛滤掉', red.length === 2, red.map((d) => d.area).join(','))
  const big = red.find((dot) => dot.area === 36)
  check('质心在方块中心', big !== undefined && Math.abs(big.x - 12.5) < 0.6 && Math.abs(big.y - 12.5) < 0.6, big ? `${big.x.toFixed(1)},${big.y.toFixed(1)}` : 'missing')
  check('门槛可调高到滤掉全部', detectDots(rgba, size, size, 'red', { ...DEFAULT_DOT_RULES, minRed: 37 }).length === 0)
  check('绿点为空时不编造', detectDots(rgba, size, size, 'green').length === 0)
}

// —— 同声腿（#128）：进/退、设备优先级、不按说话键、关掉时老链条同形
{
  const { INTERPRET_STAGE: interpStage, interpretDeviceLine: interpLine, interpretLegOf: interpLeg, interpretPlanOf: interpPlan } =
    await import('../src/shared/interpret.ts')
  check('同声腿：识别为空不进', !interpPlan({ recognized: '  ', translated: 'hello' }).speak)
  check('同声腿：译文为空不进', !interpPlan({ recognized: '打野', translated: '' }).speak)
  check('同声腿：正常一句进', interpPlan({ recognized: '打野', translated: 'jungle' }).speak)
  check('同声腿：显式设备优先于输出设备', interpLeg({ interpretInDevice: 'cable-in', ttsOutputDevice: 'spk' }).device === 'cable-in')
  check('同声腿：没指定就跟输出设备', interpLeg({ interpretInDevice: ' ', ttsOutputDevice: 'cable-0' }).device === 'cable-0')
  check(
    '同声腿：不按说话键、本机不回放译文',
    interpLeg({ interpretInDevice: 'a', ttsOutputDevice: 'b' }).keyless === true &&
      interpLeg({ interpretInDevice: 'a', ttsOutputDevice: 'b' }).monitorLocal === false
  )
  check('同声腿：阶段名独立可测', interpStage === 'interpret')
  check('同声腿：没选设备时面板说清下一步', interpLine('').includes('Dota 2') && interpLine('CABLE Input').includes('CABLE Input'))
}

// —— 构建新鲜度（#113）：读不到别假绿、打包版只报时间、宽限内外分得清
{
  const { BUILD_STALE_SLACK_MS, buildInfoOf, formatSpan, judgeBuildFreshness } = await import('../src/shared/build-info.ts')
  const T = 1_763_000_000_000
  check(
    '读不到产物 -> 说读不到，不说最新',
    judgeBuildFreshness({ stampMs: null, bytes: null, newestMainMs: T, newestRendererMs: T }).note.includes('读不到')
  )
  check(
    '打包版 -> 只报时间不判旧',
    judgeBuildFreshness({ stampMs: T, bytes: 1, newestMainMs: null, newestRendererMs: null }).stale === false
  )
  check(
    '宽限内不算旧',
    judgeBuildFreshness({ stampMs: T, bytes: 1, newestMainMs: T + BUILD_STALE_SLACK_MS - 1, newestRendererMs: T }).stale ===
      false
  )
  const stale = judgeBuildFreshness({ stampMs: T, bytes: 1, newestMainMs: T + 540_000, newestRendererMs: T })
  check('超宽限判旧并给出办法', stale.stale === true && stale.note.includes('dev:restart'), stale.note)
  check('时长文案看得出量级', formatSpan(600_000).includes('分') && formatSpan(7_200_000).includes('小时'))
  check(
    '面板视图由一处判定产生',
    buildInfoOf({ stampMs: T, bytes: 1, newestMainMs: T + 60_000, newestRendererMs: T }).behindMs === 60_000
  )
  const rendererOnly = judgeBuildFreshness({ stampMs: T, bytes: 1, newestMainMs: T, newestRendererMs: T + 260_000 })
  check(
    '只改渲染层 -> 不判旧、说已热更新、不喊重启',
    rendererOnly.stale === false && rendererOnly.scope === 'renderer' && rendererOnly.note.includes('热更新') && !rendererOnly.note.includes('dev:restart'),
    rendererOnly.note
  )
}

// —— 看一眼热键（#144）：隐藏时先亮出来，面板开着别再 toggle
{
  const { visionAskReveal } = await import('../src/shared/overlay-geometry.ts')
  const hidden = visionAskReveal({ visible: false, panelOpen: false })
  check('隐藏时按看一眼 -> 先亮出来并开面板', hidden.show === true && hidden.openPanel === true)
  const open = visionAskReveal({ visible: true, panelOpen: true })
  check('面板开着 -> 不再 toggle', open.show === false && open.openPanel === false)
}
// —— 子句流水（#71）：切句不丢字、开关关着就是一整句、账目措辞
{
  const { splitClauses, clauseStreamPlan, clauseStreamLine } = await import('../src/shared/clause-plan.ts')
  const squash = (text) => text.replace(/s+/g, '')
  const sentence = '他们开雾了。中路不见了，小心！'
  const clauses = splitClauses(sentence)
  check('切句拼回来等于原文', squash(clauses.join('')) === squash(sentence))
  check('切句落在句读后面', clauses[0] === '他们开雾了。')
  check('短碎片并进前一句', clauses.every((one) => one.length >= 4))
  check('超长硬切不越界', splitClauses('很长的句子'.repeat(20), 10).every((one) => one.length <= 10))
  const off = clauseStreamPlan({ text: sentence, enabled: false })
  check('开关关着 -> 一整句', off.streamed === false && off.clauses.length === 1)
  const on = clauseStreamPlan({ text: sentence, enabled: true })
  check('开关打开 -> 多句才流水', on.streamed === true && on.clauses.length >= 2)
  check(
    '一行账说清读/跳/首句',
    clauseStreamLine({ outcomes: ['spoken', 'skipped'], texts: ['a', ''], spoken: 1, skipped: 1, firstSpokenAt: 88, endedAt: 500 }).includes('首句 88ms')
  )
}

// —— 设置包（#81）：密钥抹掉、本机密钥顶回来、半包被拒
{
  const { stripSecrets, keepLocalSecrets, judgeSettingsBundle, settingsBundleLine } = await import('../src/shared/settings-bundle.ts')
  const { DEFAULT_SETTINGS } = await import('../src/shared/settings-shape.ts')
  const settings = {
    ...DEFAULT_SETTINGS,
    provider: { ...DEFAULT_SETTINGS.provider, apiKey: 'sk-live' },
    providerKeys: { deepseek: 'sk-live' },
    proxyUrl: 'http://u:p@127.0.0.1:4444'
  }
  const stripped = stripSecrets(settings)
  check('导出抹掉 API key', stripped.exported.provider.apiKey === '')
  check('导出抹掉 key 表', Object.keys(stripped.exported.providerKeys ?? {}).length === 0)
  check('导出抹掉代理地址', stripped.exported.proxyUrl === '')
  check('被抹的字段记下来', stripped.omitted.length === 3)
  check('非密钥字段原样带走', stripped.exported.targetLang === settings.targetLang)
  const back = keepLocalSecrets(stripped.exported, settings)
  check('导入用本机 key 顶回来', back.settings.provider.apiKey === 'sk-live')
  check('导入用本机代理顶回来', back.settings.proxyUrl === 'http://u:p@127.0.0.1:4444')
  check('报出保留了哪几项', back.kept.length === 3)
  const clean = keepLocalSecrets(stripped.exported, { ...settings, provider: { ...settings.provider, apiKey: '' }, providerKeys: {}, proxyUrl: '' })
  check('干净机器上不说保留本机', clean.kept.length === 0)
  check('缺 settings.json 直接拒', judgeSettingsBundle([{ name: 'manifest.json', bytes: 10 }]).ok === false)
  check('版本不符直接拒', judgeSettingsBundle([{ name: 'manifest.json', bytes: 1 }, { name: 'settings.json', bytes: 1 }], 99).ok === false)
  check('完整的包通过', judgeSettingsBundle([{ name: 'manifest.json', bytes: 1 }, { name: 'settings.json', bytes: 1 }], 1).ok === true)
  check('一行账空包也能说', settingsBundleLine({ files: 0, omitted: [] }) === '空包')
}

// —— 崩溃账本（#115）：诊断包里要带上 errors.jsonl，且声明走脱敏
{
  const { wantedLogFiles, LOG_BUNDLE_FILES } = await import('../src/shared/log-bundle.ts')
  const wanted = wantedLogFiles(['errors.jsonl'])
  check('诊断包声明收集 errors.jsonl', LOG_BUNDLE_FILES.some((file) => file.name === 'errors.jsonl'))
  check('errors.jsonl 走脱敏', wanted.length === 1 && wanted[0].mask === true)
  check('不在默认清单里的文件不会被塞进包', wantedLogFiles(['nope.jsonl']).length === 0)
}
// #140：「看这台机器」入口只在真有告警时出现。全绿时留一个点进去看不出任何东西的按钮，
// 比不给入口更糟——用户会以为那按钮能修好什么。
check('入口：没有告警时不出现（不留死按钮）', machineCheckOffer([false, null, undefined]).show === false)
check('入口：任一告警就出现', machineCheckOffer([false, true, null]).show === true)
check('入口：文案只有一处定义', machineCheckOffer([true]).label === MACHINE_CHECK_LABEL && MACHINE_CHECK_LABEL === '看这台机器')

check('入口：不出现时 hint 也说清为什么', machineCheckOffer([false]).hint.includes('不出现'))

// —— 供应商失败矩阵（#86）：每类各有各的话与自己的重试节奏 ——
const { judgeProviderFailure, failureLine, failuresDistinct, parseRetryAfter } = await import(
  '../src/shared/provider-failure.ts'
)
{
  const auth = judgeProviderFailure({ status: 401, message: 'HTTP 401 Invalid API key' })
  const limited = judgeProviderFailure({ status: 429, message: 'HTTP 429', retryAfter: '7' })
  const server = judgeProviderFailure({ status: 503, message: 'HTTP 503' })
  const timeout = judgeProviderFailure({ message: 'aborted', timedOut: true })
  check('失败：key 错，重试没用（换直连）', auth.retry === 'no' && auth.kind === 'auth')
  check('失败：限流按 Retry-After 等 7 秒', limited.kind === 'rate-limit' && limited.retryAfterMs === 7000)
  check('失败：5xx 隔 3 秒再试', server.kind === 'server' && server.retryAfterMs === 3000)
  check('失败：超时 1.5 秒就能再试', timeout.kind === 'timeout' && timeout.retryAfterMs === 1500)
  check('失败：四类文案互不相同', failuresDistinct([auth, limited, server, timeout]))
  check('失败：Retry-After 认不出时返回 null', parseRetryAfter('later') === null)
  check('失败：三类节奏确实不同', new Set([auth.retry, limited.retry, timeout.retry]).size === 3)
  check('失败：那句话里带下一步动作', failureLine(auth).includes('重新填'))
}
// #109：录音集的版本号由内容决定，与文件名/顺序无关；老行没有版本号就说「早于版本号」，不猜。
const { datasetVersionOf, datasetVersionFact, datasetVersionLine, datasetVersionDelta, datasetVersionDiffLine } =
  await import('../src/shared/train/dataset-version.ts')
const dvSet = [
  { key: 'G14-L01', text: '中路不见了', bytes: 32000 },
  { key: 'G14-L02', text: '上路要人来', bytes: 24000 }
]
check('数据集版本：同一组取两次相同', datasetVersionOf(dvSet) === datasetVersionOf(dvSet))
check('数据集版本：顺序无关', datasetVersionOf([dvSet[1], dvSet[0]]) === datasetVersionOf(dvSet))
check(
  '数据集版本：加一条就变',
  datasetVersionOf([...dvSet, { key: 'G14-L03', text: '买活好了', bytes: 16000 }]) !== datasetVersionOf(dvSet)
)
check('数据集版本：改一个字就变', datasetVersionOf([{ ...dvSet[0], text: '中路不见了！' }, dvSet[1]]) !== datasetVersionOf(dvSet))
check('数据集版本：空集合也有稳定前缀', datasetVersionOf([]).startsWith('ds1-'))
check('数据集版本：一行带条数与大小', datasetVersionLine(datasetVersionFact(dvSet)).includes('2 条'))
check('数据集版本：老行判 unknown 而不是 same', datasetVersionDelta(null, 'ds1-x') === 'unknown')
check('数据集版本：unknown 的文案不伪造版本号', datasetVersionDiffLine(null, 'ds1-x').includes('早于版本号'))
// #91：声出设备只在段与段之间换；坏了就退回真正工作的那台，并且要说一句。
const { planDeviceSwitch, settleDeviceAfterPlay } = await import('../src/shared/voice-device-switch.ts')
check('声出设备：没变就不换也不说话', planDeviceSwitch({ active: 'A', desired: 'A' }).line === null)
check('声出设备：段边界换设备会说「下一段」', (planDeviceSwitch({ active: 'A', desired: 'B' }).line ?? '').includes('下一段'))
check(
  '声出设备：正在播时推迟，当前这段不换',
  planDeviceSwitch({ active: 'A', desired: 'B', playing: true }).device === 'A'
)
check(
  '声出设备：回落记下真正工作的设备',
  settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: 'C', sinkLabel: 'C', hint: null }).active === 'C'
)
check(
  '声出设备：回落必须留一句',
  (settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: 'C', sinkLabel: 'C', hint: null }).line ?? '') !== ''
)
check(
  '声出设备：回落没报出设备时不乱改',
  settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: '', sinkLabel: '', hint: null }).active === 'B'
)

// #92：长句加速只在阈值之上发生，短句原样保留用户速率。
const { rateForLine, SPEECH_RATE_MAX } = await import('../src/shared/speech-rate.ts')
check('长句加速：短句原样', rateForLine({ text: 'push mid', baseRate: 0.98 }) === 0.98)
check('长句加速：长句更快且不越界', (() => {
  const rate = rateForLine({ text: '这句要足够长才能越过阈值，所以我们把同一句话重复两遍，确认它真的会被加速说出来。这句要足够长才能越过阈值。', baseRate: 1 })
  return rate > 1 && rate <= SPEECH_RATE_MAX
})())
check('长句加速：加速吃满后不再随长度上涨', rateForLine({ text: '很长'.repeat(80), baseRate: 1 }) === 1.18)
// #129：自己说话时不听自己——窗口内丢弃、窗口外放行，丢弃要能数出来。
const { judgeHalfDuplex, halfDuplexLine } = await import('../src/shared/half-duplex.ts')
check('半双工：播放窗口内丢弃', judgeHalfDuplex({ playingUntil: 2000, now: 1500 }).drop === true)
check('半双工：窗口过后放行', judgeHalfDuplex({ playingUntil: 1000, now: 5000 }).drop === false)
check('半双工：丢弃与否的文案不同', halfDuplexLine(0, 3) !== halfDuplexLine(2, 3))
if (failed > 0) {
  console.log(`${failed} 条纯逻辑断言失败`)
  process.exit(1)
}
console.log('纯逻辑断言全部通过')
