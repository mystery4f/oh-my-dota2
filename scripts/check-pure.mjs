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
const { DEVICE_ID_PLACEHOLDER, maskLogText, wantedLogFiles } = await import('../src/shared/log-bundle.ts')
const { filterHistory, historyCopyText } = await import('../src/shared/overlay-ledger.ts')
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

if (failed > 0) {
  console.log(`${failed} 条纯逻辑断言失败`)
  process.exit(1)
}
console.log('纯逻辑断言全部通过')
