import { app } from 'electron'
import {
  advanceRecording,
  initialRecordingState,
  RECORDING_LIMITS,
  parseRecordingKeyParts,
  recordingKey,
  shouldKeepTake,
  takeLineId
} from '@shared/train/recording'
import {
  buildFtDatasetEntries,
  buildFtGroupProgress,
  buildFtJsonlLine,
  splitTrainEval,
  type FtDatasetGroupView
} from '@shared/train/dataset'
import {
  canStartTrain,
  deriveTrainPlan,
  inferenceHoldLabel,
  normalizeTrainKind,
  shouldPauseInference,
  shouldResumeInference,
  type TrainTaskStatus
} from '@shared/train/task'
import { parseTrainProgress } from '@shared/train/progress'
import {
  asrFtRollbackSteps,
  asrFtSwapSteps,
  deriveAsrFtEnvGaps,
  deriveFtEpochs,
  deriveFtResumeEpochs,
  ftLedgerMatchedOnDisk,
  ftTrainCoverage,
  judgeFtVram,
  ftVramNote,
  judgeFtDataset,
  missingFtExportFiles,
  ftAppliedNote,
  parseNvidiaComputeApps,
  pickLastCheckpointName,
  planAsrFtExportArgv,
  planAsrFtTrainArgv,
  type AsrFtPaths,
  type FtLedgerEntry
} from '@shared/train/asr-ft'
import {
  buildS1TrainConfigData,
  buildS2TrainConfigData,
  GV_LEGS,
  GV_VERSION_DEFAULT,
  GV_VERSION_INFO,
  judgeGvDataset,
  normalizeGvVersion
} from '@shared/train/gv'
import {
  buildTrainRun,
  compactMetricSeries,
  compareRunsDesc,
  finishTrainRun,
  METRIC_SERIES_MAX,
  parseAsrTrainerState,
  parseGvTrainLog
} from '@shared/train/run'
import { judgeAsrPreflight, judgeGvPreflight, preflightBlocks } from '@shared/train/preflight'
import { pickLatestUvAsset, planAsrFtInstallSteps, resolveUvWheelUrl, uvWheelCandidates } from '../services/train/asr-ft-install'

/**
 * `--train-probe`：训练决策纯缝的全量行为锁（互斥闸/推理互斥/计划推导/日志行→进度/录音判定/GV 微调配置）。
 * 纯函数零进程零网络；进程生命周期（spawn/停/树杀）进 docs/ACCEPTANCE.md 人工验收。
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

export function runTrainProbe(): void {
  // —— 单任务互斥闸 ——
  push('没有任务 → 能开', canStartTrain(null).ok, JSON.stringify(canStartTrain(null)))
  push('running → 拒绝', canStartTrain('running').ok === false, canStartTrain('running').reason ?? '')
  push('preparing → 拒绝', canStartTrain('preparing').ok === false, canStartTrain('preparing').reason ?? '')
  push('stopping → 拒绝（等退干净）', canStartTrain('stopping').ok === false, canStartTrain('stopping').reason ?? '')
  push('done → 能开', canStartTrain('done').ok, JSON.stringify(canStartTrain('done')))
  push('failed → 能开', canStartTrain('failed').ok, JSON.stringify(canStartTrain('failed')))
  push('stopped → 能开', canStartTrain('stopped').ok, JSON.stringify(canStartTrain('stopped')))

  // —— 推理互斥（T2 接线的判定来源） ——
  const active: TrainTaskStatus[] = ['preparing', 'running', 'stopping']
  const ended: (TrainTaskStatus | null)[] = [null, 'done', 'failed', 'stopped']
  push('活着的任务都要推理让路', active.every((s) => shouldPauseInference(s)) && ended.every((s) => !shouldPauseInference(s)), `${active}->pause ${ended}->!pause`)
  push('退干净才恢复推理', ended.every((s) => shouldResumeInference(s)) && active.every((s) => !shouldResumeInference(s)), `${ended}->resume ${active}->!resume`)
  push('互斥判定互补', ['idle', 'preparing', 'running', 'stopping', 'done', 'failed', 'stopped'].every((s) => shouldPauseInference(s as TrainTaskStatus) !== shouldResumeInference(s as TrainTaskStatus)), 'pause 与 resume 逐态相反')

  // —— 计划推导 ——
  const demo = deriveTrainPlan({ kind: 'demo', dataset: '' })
  push('demo：node -e 跑内联脚本，可直接启动', demo.exe === 'node' && demo.args[0] === '-e' && !demo.unavailable, JSON.stringify({ exe: demo.exe, arg0: demo.args[0] }))
  push('demo 脚本带 epoch 行与 10 轮上限', demo.args.join(' ').includes('epoch ${i}/${n}') && demo.args.join(' ').includes('const n = 10'), '内联脚本内容')
  push('asr-ft：环境没附件就拒启动并说明原因', (deriveTrainPlan({ kind: 'asr-ft', dataset: '' }).unavailable ?? '').includes('环境没就绪'), deriveTrainPlan({ kind: 'asr-ft', dataset: '' }).unavailable ?? '')
  push(
    'gv-*：没 gvResolved 备料就拒启动并说明原因（T3 起是真训练，备料在主进程做）',
    (deriveTrainPlan({ kind: 'gv-gpt', dataset: '' }).unavailable ?? '').includes('没就绪') &&
      (deriveTrainPlan({ kind: 'gv-sovits', dataset: '' }).unavailable ?? '').includes('没就绪'),
    deriveTrainPlan({ kind: 'gv-gpt', dataset: '' }).unavailable ?? ''
  )
  push('乱值 kind 打回 demo', normalizeTrainKind('bogus') === 'demo' && normalizeTrainKind(42) === 'demo', `${String(normalizeTrainKind('bogus'))}/${String(normalizeTrainKind(42))}`)
  push('合法 kind 原样通过', normalizeTrainKind('gv-sovits') === 'gv-sovits', normalizeTrainKind('gv-sovits'))

  // —— asr-ft 真训练链（T5 闭环） ——
  const ftPaths: AsrFtPaths = {
    trainer: 'qwen3-sft',
    pythonExe: 'P:/ython.exe',
    sftScript: 'S/ft.py',
    exportScript: 'E/export.py',
    baseModelDir: 'M/base',
    baseModelId: ''
  }
  const ftData = { trainJsonl: 'T.jsonl', evalJsonl: 'V.jsonl', runDir: 'R' }
  const ftPlan = deriveTrainPlan({ kind: 'asr-ft', dataset: '', asrFt: { paths: ftPaths, data: ftData, exportDir: 'X' } })
  const epochAt = ftPlan.args.indexOf('--epochs')
  push('asr-ft：带环境附件出真命令（python + 冻结的试点参数）', ftPlan.exe === ftPaths.pythonExe && epochAt >= 0 && ftPlan.args[epochAt + 1] === '66' && !ftPlan.unavailable, ftPlan.args.join(' '))
  push(
    '自适应轮数：38 条→66 封顶、122→26、400→10 保底、99→32、0→66',
    deriveFtEpochs(38) === 66 && deriveFtEpochs(122) === 26 && deriveFtEpochs(400) === 10 && deriveFtEpochs(99) === 32 && deriveFtEpochs(0) === 66,
    [38, 122, 400, 99, 0].map((n) => deriveFtEpochs(n)).join('/')
  )
  const tuned = planAsrFtTrainArgv(ftPaths, ftData, { epochs: 26, lr: '1e-5', resumeFrom: 'R/checkpoint-660' })
  const flagValue = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1] ?? ''
  push(
    'tuning 覆盖：--lr/--epochs/--resume_from 三对值都对',
    flagValue(tuned, '--lr') === '1e-5' && flagValue(tuned, '--epochs') === '26' && flagValue(tuned, '--resume_from') === 'R/checkpoint-660',
    tuned.join(' ')
  )
  push('默认 argv 不带 --resume_from（新开跑）', !ftPlan.args.includes('--resume_from'), ftPlan.args.join(' '))
  const fp = (key: string, bytes: number, mtime: number): FtLedgerEntry => ({ key, wavPath: `X:/${key}.wav`, bytes, mtimeMs: mtime, text: '', split: 'train' })
  const coverage = ftTrainCoverage([fp('G14-L01', 100, 1), fp('G14-L02', 200, 2)], [
    { key: 'G14-L01', bytes: 100, mtimeMs: 1 },
    { key: 'G14-L02', bytes: 201, mtimeMs: 2 },
    { key: 'G14-L05', bytes: 300, mtimeMs: 3 }
  ])
  push(
    '已训标记：指纹全等=done、变动=stale、账本没有=没训（都计 total）',
    coverage.G14.done === 1 && coverage.G14.stale === 1 && coverage.G14.total === 3,
    JSON.stringify(coverage)
  )
  push(
    '续训对账：逐条全等放行、一条重录拒绝、空账本拒绝',
    ftLedgerMatchedOnDisk([fp('G14-L01', 100, 1)], [{ key: 'G14-L01', bytes: 100, mtimeMs: 1 }]) &&
      !ftLedgerMatchedOnDisk([fp('G14-L01', 100, 1)], [{ key: 'G14-L01', bytes: 101, mtimeMs: 1 }]) &&
      !ftLedgerMatchedOnDisk([], [{ key: 'G14-L01', bytes: 100, mtimeMs: 1 }]),
    '三态判定'
  )
  push('续训轮数：checkpoint 660 + 补 200 步、每轮 5 步 → 172', deriveFtResumeEpochs(20, 660) === 172, String(deriveFtResumeEpochs(20, 660)))
  const apps = parseNvidiaComputeApps('1234, python.exe, 4096\n7, C:\\py, torch.exe, 512\nrubbish\n')
  push(
    'nvidia-smi compute-apps 解析：pid 首逗号、显存末逗号、中间当名字、垃圾行跳过',
    apps.length === 2 && apps[0].pid === 1234 && apps[0].usedMiB === 4096 && apps[1].name === 'C:\\py, torch.exe' && apps[1].usedMiB === 512,
    JSON.stringify(apps)
  )
  const okGpu = judgeFtVram({ totalMiB: 8188, usedMiB: 4488, apps: [{ pid: 9, name: 'api_v2.py', usedMiB: 3000 }], excludePids: [9] })
  const badGpu = judgeFtVram({ totalMiB: 8188, usedMiB: 7000, apps: [{ pid: 5, name: 'python.exe', usedMiB: 2000 }], excludePids: [] })
  push(
    '显存账：自家 GV 让路后够 6400；外部占 2000 判不够并点名（判定只出提示，不拦启动）',
    okGpu.ok && okGpu.holders.length === 0 && !badGpu.ok && badGpu.holders[0].includes('python.exe'),
    JSON.stringify({ okGpu, badGpu })
  )
  push('显存账带出空闲数：4488 已用 − GV 3000 → 6700；7000 已用 → 1188', okGpu.freeMiB === 6700 && badGpu.freeMiB === 1188, `${okGpu.freeMiB}/${badGpu.freeMiB}`)
  const naRows = parseNvidiaComputeApps('49992, python.exe, [N/A]\n1844, dwm.exe, [N/A]\n')
  const naNote = ftVramNote({ totalMiB: 8188, usedMiB: 6724, apps: naRows, excludePids: [49992] })
  push(
    '显存预检：WDDM 的 [N/A] 行被跳过，提示里没有 NaN 且给出整卡数字',
    naRows.length === 0 && naNote !== null && !naNote.includes('NaN') && naNote.includes('6724') && naNote.includes('8188'),
    naNote ?? 'null'
  )
  push(
    '显存预检不再拦启动：够用没提示；不够时明说「照常开跑」',
    ftVramNote({ totalMiB: 8188, usedMiB: 1000, apps: [] }) === null &&
      (ftVramNote({ totalMiB: 8188, usedMiB: 7000, apps: [] }) ?? '').includes('照常开跑'),
    String(ftVramNote({ totalMiB: 8188, usedMiB: 7000, apps: [] }))
  )
  // 回归：官方脚本 eval_strategy="steps" 无条件，空验证集会在 trainer 构造时 ValueError，
  // 所以两个 JSONL 都得有；缺哪个就报哪个，别只给「打包失败」四个字。
  const packOk = judgeFtDataset({ ok: true, trainPath: 'D:/d/train.jsonl', evalPath: 'D:/d/eval.jsonl', error: null })
  const packNoEval = judgeFtDataset({ ok: true, trainPath: 'D:/d/train.jsonl', evalPath: '', error: null })
  const packNoTrain = judgeFtDataset({ ok: true, trainPath: '', evalPath: 'D:/d/eval.jsonl', error: null })
  const packNoRecord = judgeFtDataset({ ok: false, trainPath: '', evalPath: '', error: '还没有已录的句子——先在上方录几条再打包' })
  push(
    '打包判据：两个 JSONL 缺一不可，失败原因逐条说清',
    packOk.ok === true &&
      !packNoEval.ok &&
      packNoEval.error.includes('验证集') &&
      !packNoTrain.ok &&
      packNoTrain.error.includes('训练集') &&
      !packNoRecord.ok &&
      packNoRecord.error.includes('还没有已录的句子'),
    JSON.stringify({ packOk, packNoEval, packNoTrain, packNoRecord })
  )
  const exportArgv = planAsrFtExportArgv(ftPaths, 'R/checkpoint-330', 'X')
  const deviceAt = exportArgv.indexOf('--device')
  push('导出腿：CPU 上跑并带自校验', deviceAt >= 0 && exportArgv[deviceAt + 1] === 'cpu' && exportArgv.includes('--verify'), exportArgv.join(' '))
  push('checkpoint 挑编号最大的', pickLastCheckpointName(['eval', 'checkpoint-150', 'checkpoint-330']) === 'checkpoint-330' && pickLastCheckpointName([]) === null && pickLastCheckpointName(['checkpoint-x']) === null, String(pickLastCheckpointName(['checkpoint-150', 'checkpoint-330'])))
  push('换模序列：删旧备份→现役进备份→next 转正', JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: true, nextExists: true, exportExists: false })) === JSON.stringify(['rm-bak', 'bak-active', 'promote-next']), JSON.stringify(asrFtSwapSteps({ activeExists: false, bakExists: false, nextExists: true, exportExists: false })))
  // 回归：正常路径上 .next 还不存在，只有导出产物——旧实现只认 next，于是「导出成功点按钮」永远报没有新模型。
  push(
    '换模：只有导出产物（没有 next）也要组成序列',
    JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: false, nextExists: false, exportExists: true })) === JSON.stringify(['bak-active', 'promote-next']),
    JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: false, nextExists: false, exportExists: true }))
  )
  push('换模：没有导出产物也没有 next 才是空序列', asrFtSwapSteps({ activeExists: true, bakExists: true, nextExists: false, exportExists: false }).length === 0, '[]')
  // 回归：导出腿中途断掉时目录里已有 conv_frontend/encoder，缺 decoder.int8；
  // 那时点「应用新模型」会把残缺目录转正（识别 worker 静默死），必须逐件点名。
  push(
    '导出齐全判据：缺 decoder.int8 就不许应用，缺哪件报哪件',
    missingFtExportFiles(['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx']).length === 0 &&
      JSON.stringify(missingFtExportFiles(['conv_frontend.onnx', 'encoder.onnx', 'encoder.onnx.data'])) === '["encoder.int8.onnx","decoder.int8.onnx"]' &&
      missingFtExportFiles([]).length === 3,
    JSON.stringify(missingFtExportFiles(['conv_frontend.onnx', 'encoder.onnx', 'encoder.onnx.data']))
  )
  push(
    '换模文案点名是哪次导出：带 run id / 不带 / 失败透传',
    ftAppliedNote({ ok: true, error: null, model: 'ft-20261107181058' }).includes('ft-20261107181058') &&
      ftAppliedNote({ ok: true, error: null }) === '新模型已转正，下一句识别就用它' &&
      ftAppliedNote({ ok: false, error: '导出没跑完' }) === '导出没跑完',
    ftAppliedNote({ ok: true, error: null, model: 'ft-20261107181058' })
  )
  push('回滚序列：有备份才动手', JSON.stringify(asrFtRollbackSteps({ bakExists: true })) === JSON.stringify(['rm-active', 'restore-bak']) && asrFtRollbackSteps({ bakExists: false }).length === 0, '')
  push('环境点名：全缺四项、全齐空数组', deriveAsrFtEnvGaps({}).length === 4 && deriveAsrFtEnvGaps({ venvOk: true, sftScript: 's', exportScript: 'e', baseModelDir: 'm' }).length === 0, String(deriveAsrFtEnvGaps({}).length))
  push('安装步骤：全缺五步、全齐空序列', JSON.stringify(planAsrFtInstallSteps({ scripts: false, uv: false, venv: false, deps: false, model: false })).includes('下载 uv') && planAsrFtInstallSteps({ scripts: true, uv: true, venv: true, deps: true, model: true }).length === 0, String(planAsrFtInstallSteps({ scripts: false, uv: true, venv: false, deps: true, model: true }).length))
  const uvHtml = '<a href="../../packages/aa/bb/uv-0.9.5-py3-none-win_amd64.whl#sha256=x">u</a><a href="../../packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl#sha256=y">u</a><a href="../../packages/ee/ff/uv-0.10.2-py3-none-macosx_11_0_arm64.whl">u</a>'
  const uvCands = uvWheelCandidates(uvHtml)
  push('uv 资产挑最新 win_amd64 wheel', pickLatestUvAsset([{ name: 'uv-0.9.5-py3-none-win_amd64.whl' }, { name: 'uv-0.10.2-py3-none-win_amd64.whl' }, { name: 'uv-0.10.2-py3-none-macosx_11_0_arm64.whl' }]) === 'uv-0.10.2-py3-none-win_amd64.whl' && pickLatestUvAsset([{ name: 'uv-installer.ps1' }]) === null, String(pickLatestUvAsset(uvCands)))
  push('uv 索引解析与链接改写', uvCands.length === 2 && pickLatestUvAsset(uvCands) === 'uv-0.10.2-py3-none-win_amd64.whl' && resolveUvWheelUrl('../../packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl#sha256=y', 'https://mirrors.aliyun.com/pypi/simple/uv/') === 'https://mirrors.aliyun.com/pypi/packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl' && resolveUvWheelUrl('https://files.pythonhosted.org/packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl#sha256=y') === 'https://mirrors.aliyun.com/pypi/packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl', resolveUvWheelUrl(uvCands[1].href))

  // —— 日志行 → 进度 ——
  const p = (line: string): string => JSON.stringify(parseTrainProgress(line))
  push('epoch 3/20 → 15%', JSON.stringify(parseTrainProgress('epoch 3/20')) === JSON.stringify({ percent: 15, stage: 'epoch 3/20' }), p('epoch 3/20'))
  push('Epoch 大小写不敏感', parseTrainProgress('Epoch 12/20')?.percent === 60, p('Epoch 12/20'))
  push('epoch 10/10 → 100%', parseTrainProgress('epoch 10/10')?.percent === 100, p('epoch 10/10'))
  push('epoch 0/0 → null（防除零）', parseTrainProgress('epoch 0/0') === null, p('epoch 0/0'))
  push('tqdm 进度条 → 直接取百分比', parseTrainProgress(' 45%|█████     | 210/500 [01:10<01:26]')?.percent === 45, p(' 45%|█████     | 210/500 [01:10<01:26]'))
  push('step 120/600 → 20%', parseTrainProgress('step 120/600')?.percent === 20, p('step 120/600'))
  push('裸百分比也认', parseTrainProgress('training 99% complete')?.percent === 99, p('training 99% complete'))
  push('epoch 分式优先于裸百分比', parseTrainProgress('epoch 1/2 50%')?.stage === 'epoch 1/2', p('epoch 1/2 50%'))
  push('普通日志行 → null（只进日志环）', parseTrainProgress('loss 0.42') === null && parseTrainProgress('loading dataset') === null, `${p('loss 0.42')}/${p('loading dataset')}`)
  push('空行/纯空白 → null', parseTrainProgress('') === null && parseTrainProgress('   ') === null, `${p('')}/${p('   ')}`)


  // —— 一键打包纯缝（#14：录音×稿子→官方 JSONL） ——
  const groups: FtDatasetGroupView[] = [
    { id: 'G15', mode: 'lines', lines: [{ no: 1, text: '中路二塔快没了。' }, { no: 2, text: '下路野区刷了两组野怪。' }, { no: 3, text: '河道的神符刷新了。' }] },
    { id: 'G21', mode: 'free', lines: [] }
  ]
  const built = buildFtDatasetEntries(
    groups,
    (group, line) => group === 'G15' && (line === 'L01' || line === 'L03'),
    (group, line) => `X:/rec/${group}-${line}.wav`
  )
  push('打包只收已录的逐句句', built.entries.length === 2 && built.entries[0].wavPath.includes('G15-L01') && built.notRecorded === 1, JSON.stringify(built))
  push('自由说组整组跳过（无标准答案）', built.entries.every((entry) => entry.wavPath.includes('G15')), JSON.stringify(built.entries.map((entry) => entry.wavPath)))
  const progress = buildFtGroupProgress(
    groups,
    (key) => (key === 'G15-L01' ? 1500 : key === 'G15-L03' ? 2300 : key.startsWith('G21-T') && !key.includes('T03') && Number(key.slice(-2)) <= 2 ? 800 : null)
  )
  push(
    '组进度：缺句报名、时长累加、free 组断链即止',
    progress[0].done === 2 && progress[0].total === 3 && progress[0].missing[0] === 2 && progress[0].durationMs === 3800 && progress[1].done === 2 && progress[1].total === 2 && progress[1].missing.length === 0,
    JSON.stringify(progress)
  )
  const jsonl = buildFtJsonlLine(built.entries[0])
  push('JSONL 行带 language Chinese 前缀', jsonl.includes('"audio":"X:/rec/G15-L01.wav"') && jsonl.includes('language Chinese<asr_text>中路二塔快没了。'), jsonl)
  const split = splitTrainEval(built.entries)
  push('两条起必切验证集（官方脚本 eval_strategy 无条件 steps）', split.train.length === 1 && split.eval.length === 1, `train=${split.train.length} eval=${split.eval.length}`)
  const splitOne = splitTrainEval(built.entries.slice(0, 1))
  push('只有一条时验证集留空（打包层会先拒）', splitOne.train.length === 1 && splitOne.eval.length === 0, `train=${splitOne.train.length} eval=${splitOne.eval.length}`)
  const splitBig = splitTrainEval([1, 2, 3, 4, 5].map((no) => ({ key: `G01-L${String(no).padStart(2, '0')}`, wavPath: `w${no}`, text: `t${no}` })))
  push('够量时尾部 2 条进验证', splitBig.train.length === 3 && splitBig.eval.length === 2 && splitBig.eval[0].wavPath === 'w4', `train=${splitBig.train.length} eval=${splitBig.eval.length}`)
  // —— 录音判定（T4a 录音面板）：开停/收尾/命名全在共享缝 ——
  const t0 = 1_000_000
  const st0 = initialRecordingState(t0)
  push(
    '初态：没说过话、静音未武装',
    !st0.speechSeen && st0.quietSince === 0 && st0.startedAt === t0,
    JSON.stringify(st0),
  )
  const stepQuiet = advanceRecording(st0, { rms: 0, nowMs: t0 + 500 })
  push(
    '没说过话：静多久都不武装、不停',
    !stepQuiet.stop && stepQuiet.state.quietSince === 0,
    JSON.stringify(stepQuiet.state),
  )
  const stepSpeak = advanceRecording(stepQuiet.state, { rms: RECORDING_LIMITS.rmsThreshold, nowMs: t0 + 510 })
  push('超阈值 → speechSeen 置位', stepSpeak.state.speechSeen && !stepSpeak.stop, JSON.stringify(stepSpeak.state))
  const stepArmed = advanceRecording(stepSpeak.state, { rms: 0, nowMs: t0 + 520 })
  push(
    '说完第一块安静样本 → 静音武装',
    stepArmed.state.quietSince === t0 + 520 && !stepArmed.stop,
    `quietSince=${stepArmed.state.quietSince}`,
  )
  const stepNotYet = advanceRecording(stepArmed.state, {
    rms: 0,
    nowMs: stepArmed.state.quietSince + RECORDING_LIMITS.quietMsToStop - 1,
  })
  push('静音不足 quietMsToStop → 不停', !stepNotYet.stop, `quietSince=${stepNotYet.state.quietSince}`)
  const stepFired = advanceRecording(stepArmed.state, {
    rms: 0,
    nowMs: stepArmed.state.quietSince + RECORDING_LIMITS.quietMsToStop,
  })
  push('静音满 quietMsToStop → 自动停', stepFired.stop && stepFired.reason === '自动停', `${stepFired.stop}/${stepFired.reason}`)
  const stepCap = advanceRecording(initialRecordingState(0), { rms: 0, nowMs: RECORDING_LIMITS.maxMs })
  push(
    `满 maxMs → 到 ${RECORDING_LIMITS.maxMs / 1000}s 上限停`,
    stepCap.stop && stepCap.reason === `到 ${RECORDING_LIMITS.maxMs / 1000}s 上限`,
    `${stepCap.stop}/${stepCap.reason}`,
  )
  const stepBoth = advanceRecording(stepArmed.state, {
    rms: 0,
    nowMs: stepArmed.state.quietSince + RECORDING_LIMITS.quietMsToStop + RECORDING_LIMITS.maxMs,
  })
  push('静音时限与上限同一步命中 → 先判中的（自动停）赢', stepBoth.stop && stepBoth.reason === '自动停', stepBoth.reason ?? '')
  const tooShort = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs - 1, speechSeen: true })
  push(
    'minMs-1 → 太短丢',
    !tooShort.keep && tooShort.reason === `太短（${RECORDING_LIMITS.minMs - 1}ms），丢弃了——重新点录制`,
    tooShort.reason ?? '',
  )
  const okTake = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs, speechSeen: true })
  push('minMs + 说过话 → 收', okTake.keep && okTake.reason === null, JSON.stringify(okTake))
  const silentTake = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs, speechSeen: false })
  push(
    '说过话=false → 静音段丢（哑麦样本不进数据集）',
    !silentTake.keep && silentTake.reason === '没检测到说话，丢弃——重新点录制',
    silentTake.reason ?? '',
  )
  const shortSilent = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs - 1, speechSeen: false })
  push('太短与静音同犯 → 时长判定在前', shortSilent.reason?.startsWith('太短') === true, shortSilent.reason ?? '')
  push(
    '段键：逐句 L、自由说 T，两位补零',
    takeLineId('lines', 3) === 'L03' && takeLineId('lines', 12) === 'L12' && takeLineId('free', 1) === 'T01',
    `${takeLineId('lines', 3)}/${takeLineId('lines', 12)}/${takeLineId('free', 1)}`,
  )
  const sampleKey = recordingKey('G01', 'lines', 3)
  push(
    '录音键 Gxx-Lnn / Gxx-Tnn，写盘白名单放行合法、拦下穿越',
    sampleKey === 'G01-L03' &&
      /^G\d{2}-(?:L|T)\d{2}$/.test(sampleKey) &&
      /^G\d{2}-(?:L|T)\d{2}$/.test(recordingKey('G01', 'free', 1)) &&
      (() => {
        try {
          parseRecordingKeyParts('../evil', 'L01/../x')
          return false
        } catch {
          return parseRecordingKeyParts('G15', 'T03').group === 'G15'
        }
      })(),
    sampleKey,
  )
  // —— 推理互斥状态文案（T2 训练窗口的「为什么暂时没声」）——
  push(
    '互斥文案四态齐全',
    inferenceHoldLabel('held') === '推理已暂停（显存让给训练）' &&
      inferenceHoldLabel('kept-off').includes('未由应用托管') &&
      inferenceHoldLabel('released') === '推理已恢复' &&
      inferenceHoldLabel('release-failed').includes('恢复失败'),
    inferenceHoldLabel('held'),
  )
  // —— GV 微调（T3）：版本表 / 配置构造 / 备料验收 / 计划接线 ——
  const gvVersions = Object.keys(GV_VERSION_INFO)
  push(
    'GV 版本表六版齐全，缺省 v2ProPlus',
    gvVersions.length === 6 &&
      gvVersions.includes('v2ProPlus') &&
      normalizeGvVersion('v2') === 'v2' &&
      normalizeGvVersion('whatever') === GV_VERSION_DEFAULT,
    gvVersions.join(','),
  )
  const s2Built = buildS2TrainConfigData(
    { train: { batch_size: 4 }, data: { a: 1 }, model: { version: 'v2' } },
    {
      train: { version: 'v2ProPlus', batchSize: 8, epochs: 8 },
      expName: 'demo',
      pretrainedG: 'g.pth',
      pretrainedD: 'd.pth',
      sovitsWeightsRoot: 'SoVITS_weights_v2ProPlus'
    }
  )
  const s2Train = (s2Built?.train ?? null) as Record<string, unknown> | null
  push(
    's2 配置构造：批/轮/底模/实验目录/权重落点/版本全就位',
    !!s2Built &&
      !!s2Train &&
      s2Train['batch_size'] === 8 &&
      s2Train['epochs'] === 8 &&
      s2Train['pretrained_s2G'] === 'g.pth' &&
      s2Built['version'] === 'v2ProPlus' &&
      s2Built['s2_ckpt_dir'] === 'logs/demo' &&
      s2Built['save_weight_dir'] === 'SoVITS_weights_v2ProPlus' &&
      s2Built['name'] === 'demo',
    JSON.stringify(s2Built),
  )
  const s1Built = buildS1TrainConfigData(
    { train: { batch_size: 4, epochs: 20 } },
    { train: { version: 'v2ProPlus', batchSize: 8, epochs: 15 }, expName: 'demo', pretrainedS1: 's1.ckpt', gptWeightsRoot: 'GPT_weights_v2ProPlus' }
  )
  const s1Train = (s1Built?.train ?? null) as Record<string, unknown> | null
  push(
    's1 配置构造：批/轮/DPO/底模/三路径全就位',
    !!s1Built &&
      !!s1Train &&
      s1Train['batch_size'] === 8 &&
      s1Train['epochs'] === 15 &&
      s1Train['if_dpo'] === true &&
      s1Train['half_weights_save_dir'] === 'GPT_weights_v2ProPlus' &&
      s1Built['pretrained_s1'] === 's1.ckpt' &&
      s1Built['train_semantic_path'] === 'logs/demo/6-name2semantic.tsv' &&
      s1Built['train_phoneme_path'] === 'logs/demo/2-name2text.txt' &&
      s1Built['output_dir'] === 'logs/demo/logs_s1_v2ProPlus',
    JSON.stringify(s1Built),
  )
  push(
    '配置构造对缺节点模板回 null（引擎包不完整时拒写）',
    buildS2TrainConfigData({}, { train: { version: 'v2', batchSize: 8, epochs: 8 }, expName: 'x', pretrainedG: '', pretrainedD: '', sovitsWeightsRoot: '' }) === null &&
      buildS1TrainConfigData(null, { train: { version: 'v2', batchSize: 8, epochs: 8 }, expName: 'x', pretrainedS1: '', gptWeightsRoot: '' }) === null,
    'null-guard',
  )
  const allThere = judgeGvDataset({ expName: 'demo', phonemes: true, semantic: true, hubert: true, wav32k: true })
  const noSemantic = judgeGvDataset({ expName: 'demo', phonemes: true, semantic: false, hubert: true, wav32k: true })
  push(
    '备料验收：四件套齐 = 可开训，缺一件报名',
    allThere.ready && allThere.missing.length === 0 && !noSemantic.ready && noSemantic.missing.some((m) => m.includes('语义表')),
    `${allThere.missing.length} | ${noSemantic.missing.join(',')}`,
  )
  const gvBare = deriveTrainPlan({ kind: 'gv-sovits', dataset: 'demo' })
  const gvWired = deriveTrainPlan({
    kind: 'gv-gpt',
    dataset: 'demo',
    gvResolved: { home: 'H', pythonExe: 'P', configFile: 'C', expName: 'demo' }
  })
  push(
    'GV 计划：没备料拒启动；备好了 argv/cwd 全对（s1 用 --config_file）',
    gvBare.unavailable?.includes('没就绪') === true &&
      gvWired.unavailable === undefined &&
      gvWired.exe === 'P' &&
      JSON.stringify(gvWired.args) === JSON.stringify(['-s', 'GPT_SoVITS/s1_train.py', '--config_file', 'C']) &&
      gvWired.cwd === 'H',
    `${gvBare.unavailable ?? '-'} | ${gvWired.args.join(' ')}`,
  )
  const gvSovitsArgs = deriveTrainPlan({
    kind: 'gv-sovits',
    dataset: 'demo',
    gvResolved: { home: 'H', pythonExe: 'P', configFile: 'C', expName: 'demo' }
  })
  push(
    'GV s2 计划用 --config（非 GET 别名，照抄 webui）',
    JSON.stringify(gvSovitsArgs.args) === JSON.stringify(['-s', 'GPT_SoVITS/s2_train.py', '--config', 'C']),
    gvSovitsArgs.args.join(' '),
  )
  const sovitsLeg = GV_LEGS['gv-sovits']
  const gptLeg = GV_LEGS['gv-gpt']
  push(
    'GV 腿表是唯一真相：脚本/参数名/配置文件名/默认值同源',
    sovitsLeg.script === 'GPT_SoVITS/s2_train.py' &&
      sovitsLeg.configFlag === '--config' &&
      gptLeg.script === 'GPT_SoVITS/s1_train.py' &&
      gptLeg.configFlag === '--config_file' &&
      gptLeg.configFile === 'tmp_s1.yaml' &&
      sovitsLeg.configFile === 'tmp_s2.json' &&
      sovitsLeg.format === 'json' &&
      gptLeg.defaults.epochs === 15 &&
      sovitsLeg.templateFile(GV_VERSION_INFO.v2) === GV_VERSION_INFO.v2.s2ConfigTemplate &&
      gptLeg.requiredFiles(GV_VERSION_INFO.v2).includes(GV_VERSION_INFO.v2.s1Pretrained),
    `${sovitsLeg.script} | ${gptLeg.configFlag}`,
  )
  // —— 训练记录（run）：构建、收场、指标压缩 ——
  const started = buildTrainRun({ kind: 'asr-ft', experiment: '地图', startedAt: 1_700_000_000_000, data: { files: 40 } })
  push(
    'run 构建：id 带 kind 与时间戳，初始 running 且无终态',
    /^asr-ft-\d{14}$/.test(started.id) && started.status === 'running' && started.endedAt === null && started.data.files === 40 && started.data.bytes === 0,
    started.id,
  )
  const finished = finishTrainRun(started, { status: 'trained', endedAt: started.startedAt + 60_000, error: null })
  push(
    'run 收场：终态与结束时间写入，开始时间与 data 不动',
    finished.status === 'trained' && finished.endedAt === started.startedAt + 60_000 && finished.startedAt === started.startedAt && finished.data.files === 40,
    `${finished.status} ${finished.endedAt}`,
  )
  const longSeries = Array.from({ length: 1400 }, (_, i) => ({ step: i + 1, loss: 1 / (i + 1) }))
  const compacted = compactMetricSeries(longSeries)
  push(
    `指标压缩：1400 点压到 ${METRIC_SERIES_MAX}，首尾保住且单调不回头`,
    compacted.length === METRIC_SERIES_MAX &&
      compacted[0].step === 1 &&
      compacted[compacted.length - 1].step === 1400 &&
      compacted.every((p, i) => i === 0 || p.step > compacted[i - 1].step),
    `${compacted.length} / ${compacted[Math.floor(compacted.length / 2)].step}`,
  )
  const asrMetrics = parseAsrTrainerState({
    log_history: [
      { step: 10, epoch: 1, loss: 1.5, learning_rate: 0.00002 },
      { step: 20, epoch: 2, loss: 0.5, learning_rate: 0.00002 },
      { step: 20, eval_loss: 0.4 },
      { step: 30, epoch: 3, loss: 0.25, learning_rate: 0.00001 }
    ]
  })
  push(
    'ASR 指标：eval 行被忽略，best/last/steps/epochs 全对',
    asrMetrics !== null &&
      asrMetrics.steps === 30 &&
      asrMetrics.epochs === 3 &&
      asrMetrics.bestLoss === 0.25 &&
      asrMetrics.lastLoss === 0.25 &&
      asrMetrics.series.length === 3,
    JSON.stringify(asrMetrics && { steps: asrMetrics.steps, best: asrMetrics.bestLoss, n: asrMetrics.series.length }),
  )
  push('ASR 指标：没有 log_history 返回 null（不编空曲线）', parseAsrTrainerState({}) === null, '{}')
  const gvLog = ['====> Epoch: 1', 'saving ckpt mirana_e1:Success.', '====> Epoch: 2', 'saving ckpt mirana_e8:Success.'].join('\n')
  const gvParsed = parseGvTrainLog(gvLog)
  push(
    'GV 日志：epoch 时间线与 checkpoint 名单都提取',
    gvParsed.epochs === 2 && gvParsed.checkpoints.join(',') === 'mirana_e1,mirana_e8' && gvParsed.series.length === 2,
    `${gvParsed.epochs} | ${gvParsed.checkpoints.join(',')}`,
  )
  const newer = buildTrainRun({ kind: 'gv-sovits', experiment: 'mirana', startedAt: started.startedAt + 60_000 })
  push(
    'run 排序：新的在前',
    [started, newer].sort(compareRunsDesc)[0].id === newer.id,
    `${started.id} vs ${newer.id}`,
  )
  // 开训体检：缺环境/没录音必须 block；录音太少只 warn；没有续训点不算问题。
  const blocked = judgeAsrPreflight({
    env: { ok: false, gaps: ['torch'] },
    recordedLines: 0,
    packed: null,
    activeModel: false,
    resumeAvailable: false,
    vramNote: null
  })
  push(
    '体检：缺环境阻断',
    preflightBlocks(blocked).map((item) => item.id).join(',') === 'env,rec,model',
    preflightBlocks(blocked).map((item) => item.id).join(',')
  )
  const healthy = judgeAsrPreflight({
    env: { ok: true, gaps: [] },
    recordedLines: 4,
    packed: { train: 3, eval: 1 },
    activeModel: true,
    resumeAvailable: false,
    vramNote: '6GB 显卡建议批大小 1'
  })
  push(
    '体检：数据少只告警',
    preflightBlocks(healthy).length === 0 && healthy.some((item) => item.id === 'rec' && item.level === 'warn'),
    healthy.map((item) => `${item.id}:${item.level}`).join(' ')
  )
  const gv = judgeGvPreflight({ expName: 'mirana', missing: ['音素表 2-name2text.txt'], gptTrained: false, sovitsTrained: false })
  push('体检：GV 缺备料阻断', preflightBlocks(gv).map((item) => item.id).join(',') === 'data', gv.map((item) => `${item.id}:${item.level}`).join(' '))
  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`TRAIN_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}
