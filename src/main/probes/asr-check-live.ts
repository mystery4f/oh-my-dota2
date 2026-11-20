/**
 * 「测一遍」的真实数据验收（#47）：拿账本里已有的录音真跑一次识别，按两种切分分开报 CER。
 *
 * 为什么不在 CI 里跑：它读的是本机账本（`<userData>/train/runs.db`）与 `asr-ft/` 下的真实录音，
 * 还要加载现役识别模型——机器上没有录音时它只能报「没有可测的录音」，那不是回归信号。
 * 纯口径（CER 算法、切分、排名）由 `--train-probe` 与 `check:pure` 守着，这里只负责
 * 把「同一份数据喂给真模型，训练见过的和留出没见过的分开说」这件事跑给人看。
 */
import { existsSync } from 'node:fs'
import { formatCer, rankByCer, summarizeCerByCohort, type CerSummary } from '@shared/train/cer'
import { listDatasetEntries } from '../services/train/run-store'
import { asrCheckState, onAsrCheckChange, startAsrCheck } from '../services/train/asr-check'
import { exitProbe, finishProbe, probeCases } from './harness'

const TIMEOUT_MS = 15 * 60 * 1000
const TOP_ROWS = 12

const tone = (cohort: 'train' | 'eval' | 'unknown'): string =>
  cohort === 'train' ? '训练里见过' : cohort === 'eval' ? '留出没见过' : '未记切分'

export async function runAsrCheckLiveProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const entries = listDatasetEntries().filter((entry) => entry.text.trim() !== '' && existsSync(entry.wavPath))
  push('账本里有带标签且录音在盘上的行', entries.length > 0, `rows=${entries.length}`)
  if (entries.length === 0) {
    console.log('ASR_CHECK_LIVE_SKIP 账本里没有可测的录音（先录一些，或把 data/asr-ft 放回原处）')
    exitProbe(false, cases)
    return
  }

  const started = Date.now()
  let seen = 0
  let unsubscribe: (() => void) | null = null
  const finished = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe?.()
      resolve()
    }, TIMEOUT_MS)
    unsubscribe = onAsrCheckChange((next) => {
      if (next.done > seen) {
        seen = next.done
        if (next.done % 10 === 0) console.log(`ASR_CHECK_LIVE_PROGRESS ${next.done}/${next.total} ${next.current}`)
      }
      if (!next.running) {
        clearTimeout(timer)
        unsubscribe?.()
        resolve()
      }
    })
  })
  startAsrCheck()
  await finished

  const state = asrCheckState()
  const elapsedMs = Date.now() - started
  push('识别跑完且没有别的错误', state.error === null && state.running === false, `error=${state.error ?? 'null'}`)
  push('每条录音都出了结果（缺文件的也有一行）', state.items.length === state.total, `items=${state.items.length} total=${state.total}`)
  push('每条都记了切分', state.items.every((item) => item.cohort === 'train' || item.cohort === 'eval' || item.cohort === 'unknown'))

  const byCohort = summarizeCerByCohort(state.items)
  const buckets: { cohort: 'train' | 'eval' | 'unknown'; summary: CerSummary }[] = [
    { cohort: 'train', summary: byCohort.train },
    { cohort: 'eval', summary: byCohort.eval },
    { cohort: 'unknown', summary: byCohort.unknown }
  ]
  for (const bucket of buckets) {
    console.log(
      `ASR_CHECK_LIVE_COHORT ${bucket.cohort} rows=${bucket.summary.rows} chars=${bucket.summary.chars} ` +
        `distance=${bucket.summary.distance} cer=${formatCer(bucket.summary.cer)} clean=${bucket.summary.clean}`
    )
  }
  // 两种切分必须都能说出口：只有训练集有数据时，泛化这件事就没人量。
  push(
    '切分至少分出两组（训练 / 留出）',
    byCohort.train.rows > 0 && byCohort.eval.rows > 0,
    buckets.map((bucket) => `${bucket.cohort}:${bucket.summary.rows}`).join(' ')
  )
  const worst = rankByCer(state.items).slice(0, TOP_ROWS)
  for (const row of worst) {
    console.log(
      `ASR_CHECK_LIVE_ROW ${row.key} [${tone(row.cohort)}] ` +
        `cer=${formatCer(row.cer)} (${row.distance}/${row.chars})`
    )
  }
  push('最差的那条确实有错字', (worst[0]?.distance ?? 0) > 0, `worst=${worst[0]?.key ?? 'none'} distance=${worst[0]?.distance ?? 0}`)
  push('排名是从差到好（CER 不升）', rankByCer(state.items).every((row, index, all) => index === 0 || all[index - 1].cer >= row.cer))
  push('跑完用了不到 15 分钟', elapsedMs < TIMEOUT_MS, `elapsedMs=${elapsedMs}`)

  finishProbe('ASR_CHECK_LIVE_PROBE', cases, {
    total: state.total,
    elapsedMs,
    cohorts: buckets.map((bucket) => `${bucket.cohort}:${bucket.summary.rows}@${formatCer(bucket.summary.cer)}`),
    worst: worst.slice(0, 3).map((row) => `${row.key}:${formatCer(row.cer)}`)
  })
}
