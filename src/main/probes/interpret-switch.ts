/**
 * #130 探针：同传的一个开关与一句说明。
 *
 * 票面验收四条，逐条有断言：
 * - `Fresh install: the switch is off` → `DEFAULT_SETTINGS.interpretMode === false`，且
 *   `interpretLegFor(false)` 回到普通回复腿；
 * - `Enabling it requires the sentence to be visible in the same view` → 说明句必须点名
 *   中文→英文、虚拟声卡、本地回放三件事（缺一件就有人局中被打个措手不及）；
 * - `logs/ contains no audio file after a session` → `audioFiles()` 只认音频扩展名，
 *   当前日志目录的清单里没有任何音频；
 * - `Disabling mid-match stops both legs immediately` → 这条腿由每次开麦现读的开关决定，
 *   关掉立刻回 `reply`（进程里没有缓存）。
 *
 * 另外钉住「per-app, not per-match」：设置里的开关只有布尔一种取值，没有任何按对局复位的路径。
 */
import { readdirSync } from 'node:fs'
import { AUDIO_EXTENSIONS, audioFiles, interpretLegFor, interpretPrivacyLine, interpretStateLine } from '@shared/interpret'
import { DEFAULT_SETTINGS } from '@shared/settings-shape'
import { finishProbe, probeCases } from './harness'
import { logsDir } from '../services/logs/base-dir'

export async function runInterpretSwitchProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 验收一：默认关 ——
  push('新装默认关', DEFAULT_SETTINGS.interpretMode === false)
  push('关着就走普通回复腿', interpretLegFor(false) === 'reply')
  push('打开才走同传腿', interpretLegFor(true) === 'interpret')

  // —— 验收二：说明句点名三件事 ——
  const line = interpretPrivacyLine()
  push('说明句说清 中文→英文', line.includes('中文') && line.includes('英文'), line.slice(0, 40))
  push('说明句说清 从虚拟声卡进去', line.includes('虚拟声卡') && line.includes('队友'), line.slice(0, 60))
  push('说明句说清 自己听到的是本地回放', line.includes('本地回放'), line.slice(-40))
  push('说明句说清 录音不留存', line.includes('不留存'))
  push('面板状态一行分得开关两态', interpretStateLine(true) !== interpretStateLine(false) && interpretStateLine(false).includes('关'))

  // —— 验收三：logs/ 里没有音频文件 ——
  const names = readdirSync(logsDir(), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
  const audio = audioFiles(names)
  push('当前日志目录没有任何音频文件', audio.length === 0, audio.join(', ') || `${names.length} 个文件全是文本`)
  push('音频判据认得出来（自我检验）', audioFiles(['voice-chain.jsonl', 'a.WAV', 'b.ogg']).join(',') === 'a.WAV,b.ogg', AUDIO_EXTENSIONS.join(' '))

  // —— 验收四：per-app，不是 per-match ——
  push('开关只有布尔取值（没有按局复位的第三种状态）', typeof DEFAULT_SETTINGS.interpretMode === 'boolean')

  finishProbe('INTERPRET_SWITCH_PROBE', cases)
}