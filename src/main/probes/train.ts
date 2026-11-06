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
  pickLastCheckpointName,
  planAsrFtExportArgv,
  type AsrFtPaths
} from '@shared/train/asr-ft'
import {
  buildS1TrainConfigData,
  buildS2TrainConfigData,
  GV_VERSION_DEFAULT,
  GV_VERSION_INFO,
  judgeGvDataset,
  normalizeGvVersion
} from '@shared/train/gv'
import { pickLatestUvAsset, planAsrFtInstallSteps } from '../services/train/asr-ft-install'

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
  const ftPaths: AsrFtPaths = { pythonExe: 'P:/ython.exe', sftScript: 'S/ft.py', exportScript: 'E/export.py', baseModelDir: 'M/base' }
  const ftData = { trainJsonl: 'T.jsonl', evalJsonl: 'V.jsonl', runDir: 'R' }
  const ftPlan = deriveTrainPlan({ kind: 'asr-ft', dataset: '', asrFt: { paths: ftPaths, data: ftData, exportDir: 'X' } })
  const epochAt = ftPlan.args.indexOf('--epochs')
  push('asr-ft：带环境附件出真命令（python + 冻结的试点参数）', ftPlan.exe === ftPaths.pythonExe && epochAt >= 0 && ftPlan.args[epochAt + 1] === '66' && !ftPlan.unavailable, ftPlan.args.join(' '))
  const exportArgv = planAsrFtExportArgv(ftPaths, 'R/checkpoint-330', 'X')
  const deviceAt = exportArgv.indexOf('--device')
  push('导出腿：CPU 上跑并带自校验', deviceAt >= 0 && exportArgv[deviceAt + 1] === 'cpu' && exportArgv.includes('--verify'), exportArgv.join(' '))
  push('checkpoint 挑编号最大的', pickLastCheckpointName(['eval', 'checkpoint-150', 'checkpoint-330']) === 'checkpoint-330' && pickLastCheckpointName([]) === null && pickLastCheckpointName(['checkpoint-x']) === null, String(pickLastCheckpointName(['checkpoint-150', 'checkpoint-330'])))
  push('换模序列：删旧备份→现役进备份→next 转正', JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: true, nextExists: true })) === JSON.stringify(['rm-bak', 'bak-active', 'promote-next']), JSON.stringify(asrFtSwapSteps({ activeExists: false, bakExists: false, nextExists: true })))
  push('换模：没有导出产物就是空序列', asrFtSwapSteps({ activeExists: true, bakExists: true, nextExists: false }).length === 0, '[]')
  push('回滚序列：有备份才动手', JSON.stringify(asrFtRollbackSteps({ bakExists: true })) === JSON.stringify(['rm-active', 'restore-bak']) && asrFtRollbackSteps({ bakExists: false }).length === 0, '')
  push('环境点名：全缺四项、全齐空数组', deriveAsrFtEnvGaps({}).length === 4 && deriveAsrFtEnvGaps({ venvOk: true, sftScript: 's', exportScript: 'e', baseModelDir: 'm' }).length === 0, String(deriveAsrFtEnvGaps({}).length))
  push('安装步骤：全缺五步、全齐空序列', JSON.stringify(planAsrFtInstallSteps({ scripts: false, uv: false, venv: false, deps: false, model: false })).includes('下载 uv') && planAsrFtInstallSteps({ scripts: true, uv: true, venv: true, deps: true, model: true }).length === 0, String(planAsrFtInstallSteps({ scripts: false, uv: true, venv: false, deps: true, model: true }).length))
  push('uv 资产挑最新 windows zip', pickLatestUvAsset([{ name: 'uv-0.9.5-x86_64-pc-windows-msvc.zip' }, { name: 'uv-0.10.2-x86_64-pc-windows-msvc.zip' }, { name: 'uv-0.10.2-aarch64-apple-darwin.tar.gz' }]) === 'uv-0.10.2-x86_64-pc-windows-msvc.zip' && pickLatestUvAsset([{ name: 'uv-installer.ps1' }]) === null, String(pickLatestUvAsset([{ name: 'uv-0.9.5-x86_64-pc-windows-msvc.zip' }])))

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
  push('数据太少全归训练（验证留空）', split.train.length === 2 && split.eval.length === 0, `train=${split.train.length} eval=${split.eval.length}`)
  const splitBig = splitTrainEval([1, 2, 3, 4, 5].map((no) => ({ wavPath: `w${no}`, text: `t${no}` })))
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
    gvResolved: { home: 'H', pythonExe: 'P', configFile: 'C', script: 'GPT_SoVITS/s1_train.py' }
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
    gvResolved: { home: 'H', pythonExe: 'P', configFile: 'C', script: 'GPT_SoVITS/s2_train.py' }
  })
  push(
    'GV s2 计划用 --config（非 GET 别名，照抄 webui）',
    JSON.stringify(gvSovitsArgs.args) === JSON.stringify(['-s', 'GPT_SoVITS/s2_train.py', '--config', 'C']),
    gvSovitsArgs.args.join(' '),
  )
  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`TRAIN_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}
