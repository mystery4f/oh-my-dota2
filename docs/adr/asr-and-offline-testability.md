# ADR：四处「先拆纯缝，再谈可测」

- 状态：已定（2026-11-21，pm 拍板）
- 相关票：#153 #154 #155 #156

## 背景

四件事看起来是「补四个探针」，实际上是四处**判定与 IO 缠在一起**的代码，探针没法在不污染真实数据目录、不抢真实端口、不要求模型在场的前提下验证它们：

| 位置 | 现状 | 探针为什么插不进去 |
| --- | --- | --- |
| `src/main/services/voice/offline.ts:96` `offlineReady(voice)` | 直接 `existsSync` 读 `<userData>/tts-models/…` | 要造「就绪/缺一件/缺 vocoder」三态就得往真实数据目录写文件，而探针不许写用户数据 |
| `read.tsx:351-380` 的四态文案 | 文案写在 JSX 里，`error !== null && !ready` 时才出「下载失败」 | 这只是两行 if，但它现在是渲染层的事，探针只能靠截图 |
| `src/main/services/voice/asr-model.ts:246` | `transcribeAsr()` 直接读 `loadSettings().asrRouteShortLong` 再调纯缝 `routeAsrClip` | 纯缝已覆盖，「settings → 入参 → 真的换了目录」这一段没人钉 |
| `src/main/services/env-report.ts` `envReport(devices)` | 端口写死 `GSI_PORT`，试绑真实 32123 | 想验「被别的程序占着」就得真占应用自己的端口 |

## 决定

四处各拆一条纯缝，IO 留在原处：

- `judgeOfflineReady(files, exists) → { ready, missing: string[], reason: 'dir-missing' | 'file-missing' | 'vocoder-missing' | 'dict-missing' | null }`
  —— 返回**原因**而不是布尔。界面才有资格说「缺 vocoder 那一个文件」，而不是笼统「未就绪」。
- `offlineUiState(status) → 'ready' | 'missing' | 'downloading' | 'failed'`，且 `failed` 自带 `text: '下载失败：<error>'`。
  —— 四态与判据的对应关系落在纯缝里，寄存器那一行只负责显示。
- `routingFor(settings, models) → routeAsrClip 的入参`（`{ ruleOn, shortReady, longReady }` 等）。
  —— `transcribeAsr()` 只调它；探针可以在任何机器上断言「开关 false 时 `ruleOn:false`」「两副 ready 时选另一副」「短句模型没 ready 时留在现役」。
- `envReport(devices, port = GSI_PORT)`。
  —— 注入高位端口（例如 45123）即可验「`other`」，不必和应用自己的 32123 抢；**注入值必须打进探针输出**（`env-probe port=45123`），否则看日志分不清哪次是注入。

## 不这样做的地方

- 不给 `offlineStatus` 加 `dir` 参数：那等于把测试钩子塞进生产签名，`offlineReady` 的 IO 也只该有一处。
- 不为「下载失败」造第二套下载舞台：`--download-probe` 已经钉死断流、`.part` 续传与失败归属（网络 / 源站），再测一遍是把同一件事测两遍。
- 不改 `GSI_PORT` 的默认值，也不让应用可以监听别的端口：注入只存在于探针调用路径上。

## 后果

- 四个新探针里，只有 `--asr-routing-wire-probe` 依赖「模型在场」：本机装了 qwen3 与 paraformer 时**必须真换**（`ASR_ROUTE` 里出现两个不同 `engine`），缺模型时 SKIP 并点名缺哪个——静默通过是不允许的。
- `--offline-status-probe` / `--env-report-probe` 在任何机器上都能跑，不写用户数据、不申请麦克风、不占 32123。
- 纯缝一旦拆出，`read.tsx` 与 `asr-train.tsx` 的文案必须跟着纯缝走，不许再在 JSX 里二次判断——否则探针绿了而界面是另一套逻辑。
