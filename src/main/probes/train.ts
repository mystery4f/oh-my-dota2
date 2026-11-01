import { app } from 'electron'
import {
  buildFtDatasetEntries,
  buildFtJsonlLine,
  canStartTrain,
  deriveTrainPlan,
  normalizeTrainKind,
  parseTrainProgress,
  shouldPauseInference,
  shouldResumeInference,
  splitTrainEval,
  type FtDatasetGroupView,
  type TrainTaskStatus
} from '@shared/train'

/**
 * `--train-probe`：训练决策纯缝的全量行为锁（互斥闸/推理互斥/计划推导/日志行→进度）。
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
  push('asr-ft：T1 拒启动并说明去向', (deriveTrainPlan({ kind: 'asr-ft', dataset: '' }).unavailable ?? '').includes('T5'), deriveTrainPlan({ kind: 'asr-ft', dataset: '' }).unavailable ?? '')
  push('gv-gpt：T1 拒启动并说明去向', (deriveTrainPlan({ kind: 'gv-gpt', dataset: '' }).unavailable ?? '').includes('T3'), deriveTrainPlan({ kind: 'gv-gpt', dataset: '' }).unavailable ?? '')
  push('gv-sovits：T1 拒启动并说明去向', (deriveTrainPlan({ kind: 'gv-sovits', dataset: '' }).unavailable ?? '').includes('T3'), deriveTrainPlan({ kind: 'gv-sovits', dataset: '' }).unavailable ?? '')
  push('乱值 kind 打回 demo', normalizeTrainKind('bogus') === 'demo' && normalizeTrainKind(42) === 'demo', `${String(normalizeTrainKind('bogus'))}/${String(normalizeTrainKind(42))}`)
  push('合法 kind 原样通过', normalizeTrainKind('gv-sovits') === 'gv-sovits', normalizeTrainKind('gv-sovits'))

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
  const jsonl = buildFtJsonlLine(built.entries[0])
  push('JSONL 行带 language Chinese 前缀', jsonl.includes('"audio":"X:/rec/G15-L01.wav"') && jsonl.includes('language Chinese<asr_text>中路二塔快没了。'), jsonl)
  const split = splitTrainEval(built.entries)
  push('数据太少全归训练（验证留空）', split.train.length === 2 && split.eval.length === 0, `train=${split.train.length} eval=${split.eval.length}`)
  const splitBig = splitTrainEval([1, 2, 3, 4, 5].map((no) => ({ wavPath: `w${no}`, text: `t${no}` })))
  push('够量时尾部 2 条进验证', splitBig.train.length === 3 && splitBig.eval.length === 2 && splitBig.eval[0].wavPath === 'w4', `train=${splitBig.train.length} eval=${splitBig.eval.length}`)
  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`TRAIN_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}
