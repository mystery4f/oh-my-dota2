# TODO（跨会话交接）

> 这份文件是给「下一个会话的自己」看的：先读这一页，再动代码。
> 计划与里程碑在 `docs/PLAN.md`，工程踩坑在 `docs/NOTES.md`，手册在 `docs/ACCEPTANCE.md`。

## 刚完成并已验证

**Nightly / 正式版更新通道分离**（提交 `a186609`；产物验证通过）

- Nightly 流水线先改 `package.json` 版本为 `X.Y.Z-nightly.<UTC 时间戳>`，再用
  `npm run pack:win -- --config.publish.channel=nightly` 打包。
- `src/main/services/updater.ts` 按 `app.getVersion().includes('-nightly.')` 选通道：
  Nightly 读 `nightly.yml` + 允许预发布，正式包读 `latest.yml` + 拒绝预发布，两边都禁止降级。
- 面板版本号旁显示 `· Nightly`。

**实测证据（2026-10-24 19:17 build）**：

```
tag      nightly-20261024-191754
assets   nightly.yml                 ← 不再是 latest.yml
         oh-my-dota2-1.0.0-nightly.20261024-191754-x64.exe
nightly.yml → version: 1.0.0-nightly.20261024-191754
```

对照：改动前那次（`nightly-20261024-182120`）产物是 `latest.yml` + `1.0.0`，正是「Nightly 被当成 v1.0.0」的物证。

还没做的：装这个 Nightly 包，确认面板显示 `· Nightly`、日志出现
`UPDATE_CHANNEL {channel:'nightly'}`，且检查更新不会提示 v1.0.0。

## 已完成（留档，别当成待办重做，也别再从列表里删掉）

| 做完的 | commit | 一句话 |
|---|---|---|
| 翻译记账本双向化 | `5cbc1f9` 一线 | 一次翻译存一对（`a` 键 + `b` 译文），正向按 `a` 命中，反查走 `b` 索引；用户场景「我说你好→队友说 hello 也直接出中文」 |
| 词频统计读取端（M11a，原 `#4`） | `5cbc1f9` | `translationInsights()` + 面板「词库 N 对 · 命中 M 次」+ 探针 21 项 |
| 输入过滤三道（原 `#5`） | `e8b43f9` | `worthTranslating()`（纯符号/纯数字/少于 3 字符不翻）+ `sameText()`（同形不入账）+ GSI 局末 `endMatchSession()` |
| 翻译门槛 ≥3 字符（原 `#6`） | `4600e7d` | `worthTranslating()` 要求「≥3 个码点且含字母或汉字」：`gg`/`ok`/`嗯` 不再进模型队列，照常上屏与朗读；早先的「长度 1 不翻」是同一函数的旧门槛，已被这一档取代 |
| 翻译失败可见（原 `#8`） | `9abcede` | `CaptureEntry.error`，浮层不再永远停在「未翻译」 |
| 浮层几何归用户 | `561f87e` | 锁定/拖动/左右改宽/还原；锁定 = 几何冻住 + 强制穿透 |
| 浮层收起小图标 + 朗读开关 | `65c8ebf` | 解锁条两个新按钮；收起后恒可点，不被 `clampGeometry` 的下限撑开 |
| 词标区分词库与现翻 | `aafa518` 一线 | `.trans.cached` 加「词」角标 |
| 英雄头像 | `7322edb` | 127 张打包，`[英雄名] → <img>`，未知英雄自动退回文字 |
| OCR 全链路删除 | `e34f06f` | 抓屏/PaddleOCR/onnxruntime/区域选择全删，安装包 102 MB |
| 离线朗读四音色 | `6987d9e` | `melo` / `baker` / `xiao_ya` / `eula`，matcha 要单独声码器 |
| Edge 分句流式 | `fb496da` | `splitForSpeech` 按标点切 ≤20 字，并行合成、顺序播放 |
| 便携数据目录 | `ccfe1cc` / `b8caa91` | 安装版写安装目录同级的 `<dir>-data`，dev 用 `./data`；旧位置按字段合并迁移 |
| 卸载保留数据 | `0303915` / `e9ac690` | 主程序被搬进临时目录再删，`data` 原地不动 |
| 更新通道分离 | `a186609` | Nightly 读 `nightly.yml` 允许预发布，正式包读 `latest.yml` 拒绝预发布 |
| 词库索引自愈 | `9e41781` / `fe0af5b` | 索引损坏时 `SELECT` 仍能读、`INSERT` 必炸；改为隔离坏库重建，别误判成「数据库丢了」 |
| 语音选择拆回两个下拉 | `b22a80e` | 分类 + 选项，避免「名称 / 本地模型」混成一个框 |
| 朗读跳过自己那句（原 `#23`） | `e99a304` | `decideSpeak` 补上 `own` 判空：真对局里自己的 `::` 被念成「司夜刺客说，」+ 敌方 BASE 译文「基地」连听，用户听成「司夜刺客说基地」报了英雄识别错误 |
| 离线朗读静默失效 | `48a6f61` | `SpeakOptions` 漏传 `engine` → 离线 WAV 被标 `audio/mpeg` 解不开；联网正常离线无声的根因 |
| 自己的话可念开关 | `982898e` | `ttsReadOwn`（默认不念）+ 面板「自己的话：念/不念」，探针钉住开关两侧 |
| 翻译门槛 ≥3 字符（原 `#6`） | `4600e7d` | `worthTranslating()` 要求「≥3 个码点且含字母或汉字」：`gg`/`ok`/`嗯` 不再进模型队列，照常上屏与朗读；早先的「长度 1 不翻」是同一函数的旧门槛，已被这一档取代 |
| 朗读前缀三级化 | `feafdd2` | 英雄名 → [关系]（队友说/敌方说）→ 光念内容；allplayers 真对局一帧不推的补救 |
| 朗读可观测日志 | `48c940b` | `TTS_SPEAK_PICK`/`TTS_SPEAK_SKIP` + `gsi-chat.jsonl` 加 `hero`/`relation` 字段 |

## 编号对照（1–23 一个不少，改这一节前先读它）

编号是稳定身份。凡是历史上出现过的号，要么在「已完成」表里，要么在下面的待办分组里，**不允许消失**。

| 号 | 状态 | 在哪 |
|---|---|---|
| `#1` | 待办·等真对局 | 「需要一局真实天梯」组，GSI 正文可靠性对账 |
| `#2` | 待办·改代码 | 同组；36% missRate 是口径虚高，改 `worthTranslating && !hasHan && !own` 后复算 |
| `#3` | 已完成 | 2026-10-25 真对局实证（见下），详录 PLAN.md M10b |
| `#4` | 已完成 | 上表「词频统计读取端（M11a）」 |
| `#5` | 已完成 | 上表「输入过滤三道」 |
| `#6` | 已完成 | 上表「翻译门槛 ≥3 字符」 |
| `#7` `#9` `#10` `#11` `#15` | 待办·可离线 | 「浮层与交互」组 |
| `#8` | 已完成 | 上表「翻译失败可见」 |
| `#12` `#13` `#14` `#17` | 待办·可离线 | 「GSI 进阶玩法」组（`#12` 局末战报、`#13` 事件提醒、`#14` 装备提醒、`#17` BP 阵容） |
| `#16` | 待办·可离线 | 「发送与输入」组 |
| `#18` | 已关闭 | OCR 已整条删除，不需要「可选下载」 |
| `#19` | 待办·可离线 | 「朗读」组，流式首包播放 |
| `#20` | 已完成 | 「已关闭」组末条，离线引擎四音色；细节见「离线朗读（2026-11 定案）」 |
| `#21` `#22` | 待办·可离线 | 「朗读」组，baker 声码器下载 / Edge 分句基线 |
| `#23` | 已完成 | 上表「朗读跳过自己那句」，2026-10-25 真对局 9060903477 发现 |

历史遗留说明：`#4`/`#5`/`#6`/`#8` 这四条曾经只存在于会话的 todo 工具里、从没进过本文件，
2026-11 清列表时一度被当成残留删掉，现已按原内容写回上表——**它们是真实做过的工作，不是噪音**。

## 待办（按优先级）

编号是稳定的身份，不是顺序；新条目往后加，不要在中间插号。

### 需要一局真实天梯（#1 唯一的硬阻塞）

`#1` 必须等下一局真对局；`#2` 数据已采到，改完口径代码就能复算，不用再开局。

- `#1` GSI 正文可靠性：一局真实天梯里 `gsi-chat.jsonl` 的行是否齐全、去重后条数、与浮层实际上屏条数是否对得上
  - 工具现状：`--match-report` 已改为只读 GSI 日志 + 账本，OCR 时代的逐拍指标随 OCR 一起删了。
- `#2` 账本覆盖率口径复核（已采到数据，待改代码）
  - 现状：`--match-report` 的 `ledgerCoverage` 在 `chatSource=gsi` 下算的是「GSI 行 vs 账本行」，近 600 分钟实测 `missRate 36%` 属虚高——`b`/`g`/`。。` 这类 **by-design 跳过**被算成漏行。
  - 排除 by-design 后唯一可疑样本：`need gank, pos 5`（值得单独查一次是不是真的没进队列）。
  - 改法：覆盖率只对「本应进模型队列」的行计算（`worthTranslating && !hasHan && !own`）；改完仍无意义就把这段删掉。
- ~~#3~~ **已完成（2026-10-25）**：真对局 9060804477 / 9061130332 全程帧到达、聊天入库、own 正确、`POST_GAME` 终落、matchid 翻转清缓存（`9d91f0b` 依据即此数据）

### 朗读（用户体感最敏感的一块）

- `#19` Edge 改**流式播放**（未开工，方案已定）
  - 现状：`src/main/services/voice/edge.ts` 的 `synthesize()` 走 `toBuffer()`，**整段合成完才返回**，
    实测 700–1639 ms（12 次采样，p50 ≈ 1.2 s）；`speech.ts` 的 `deliver()` 拿到完整 Buffer 才下发播放。
    感知延迟 = 合成总时长，而不是首字时间。
  - 注意与 `#22` 的区别：`#22` 是「一句话切成几段、各段并行合成」，已落地；
    `#19` 是「单段还没合成完就先出声」，两者独立，`#19` 才是把感知延迟压到 250 ms 的那一步。
  - 目标：首包即播，感知延迟降到约 250 ms。音质不变（同一嗓子、同一码率）。
  - 做法：**不要等 `toBuffer()`**。`@andresaya/edge-tts` 的 `synthesize()` 是事件流，收到第一个音频
    chunk 就通过 IPC 推给渲染层；渲染层用 `MediaSource` + `SourceBuffer('audio/mpeg')`
    （`mode = 'sequence'`，因为 mp3 无全局索引）边收边追加，第一个 chunk 进 buffer 就能播。
  - 收尾与打断：合成结束调 `mediaSource.endOfStream()`；新的一句到达时先 `sourceBuffer.abort()` +
    `mediaSource.endOfStream()` 再新建，否则旧句会续播。
  - 兜底：流式通道失败（Edge 偶发 0 字节，已有 `EDGE_TTS_EMPTY` 与一次重试）时回退到现在的整段模式；
    **任何情况下都不许退回系统嗓子**，静音也比换嗓好。
  - 打点与验收：新增 `EDGE_TTS_FIRST_BYTE {ms}`（首包）、沿用 `EDGE_TTS_OK {ms,bytes}`（总量）；
    `--tts-bench` 增加首包 p50/p90 与「首包/总时长」比值；验收线：首包 p50 < 400 ms、
    整段 p50 不劣化、`--tts-play-probe` 仍绿。
  - 已知风险：`MediaSource` 在 Electron 渲染层对 `audio/mpeg` 的支持需实测（Chromium 支持 mp3 MSE，
    但无 duration 时 seek 与 `currentTime` 会异常——本项目不需要 seek，只要末位追加）。
    若 MSE 不可用，退化方案是按 MP3 帧边界切首批约 200 ms 交给 `AudioContext.decodeAudioData` 播放，
    剩余部分继续排队，代价是多写一个帧头解析器。
  - 涉及文件：`src/main/services/voice/edge.ts`、`src/main/services/voice/speech.ts`、
    `src/shared/ipc.ts`（`SpeakPayload` 需要 chunk 形态）、`src/renderer/src/`（播放侧）。
- `#22` Edge **分句流式**已实现但没测过数字：`splitForSpeech`（≤20 字按标点切）+ 并行合成 + 顺序播放
  （commit `fb496da`），`SPEAK_QUEUE_MAX` 已从 3 提到 6。
  - 缺的是基线：首段延迟、整句延迟、失败率都还没跑（`--tts-bench` 要独占实例，dev 应用持有单实例锁）。
  - 验收：关掉 dev 应用后 `npx electron out/main/index.js --tts-bench`，首段 p50 应明显低于整句 p50。
  - 2026-10-25 实测基线（`--tts-bench`，10/10）：p50 815 ms / max 974 ms / 整句 1080 ms / 首段 1249 ms、`segmentsOk:true`、`firstAudioOk:true`——分句链路通，但首段没比整句快，流式首包（#19）仍是把感知延迟压下去的关键。
- `#21` baker 的声码器在**安装版**首次下载没验证过：`vocos-22khz-univ.onnx`（53 MB，放 `tts-models/` 根目录，
  四个音色共用）只在 dev 用户态跑过，安装版写的是 `G:\oh-my-dota2-data\tts-models\`。
  - 验收：安装版把引擎切「本地模型」选 baker，看到下载日志 → 模型就绪 → 出声；
    弱网可先手动把 onnx 丢进该目录，程序检测到就不下。

### 浮层与交互

- `#7` 同一句高频重复时浮层合并成一行并标注 ×N（只改渲染层）
- `#9` 行点击复制原文
- `#10` 浮层滚动历史（上翻看旧句）
- `#11` `Alt+Shift+X` 清屏
- `#15` 指挥类消息高亮

### GSI 进阶玩法（都建立在 `allplayers` 真的到齐之上）


> 2026-10-25 注：本组前提已证伪——真对局 3499 帧 `allplayers` 一帧未推（cfg 明确开着；`allplayers` 是 CS:GO 的块名，Dota 2 GSI 只推本机玩家）。整组挂起，除非哪天 Valve 真的推了（代码侧 `refreshSlotNames` 一直接得住）。
- `#12` 局末战报：`POST_GAME` 时汇总本局数据
- `#13` 事件提醒：击杀 / 肉山 / 符点用朗读播报
- `#14` 敌方关键装备提醒
- `#17` BP 阶段阵容中文名提示

### 发送与输入

- `#16` 快捷短语一键发送

### 已关闭（留档，别再当待办捡回来）

- `#18` ~~把 OCR 从默认包里摘出去~~ —— OCR 已整条删除（commit `e34f06f`），无需「可选下载」
- `#20` 离线引擎 —— 已完成；最终形态见下面「离线朗读（2026-11 定案）」一节：
  四个音色 `melo` / `baker` / `xiao_ya` / `eula`，`sherpa-onnx-node` 跑在系统 node 子进程里。
  - 选型过程留档，别再重复试：`vits-zh-aishell3` 只有 8 kHz；`kokoro-multi-lang-v1_1` 要 jieba + 词典 + FST，
    RTF 1.3–2.7 最慢；`baker` 先因音色被否、后又被留用；`melo` 44.1 kHz 最好听但每句重载 183 MB，冷启动 5 s。
  - 运行时铁律：Electron 的任何运行时（包括 `ELECTRON_RUN_AS_NODE`）都会抛
    `External buffers are not allowed`，只有系统 `node.exe` 子进程能跑 sherpa。
  - 模型不进安装包（只为体积），首次选音色时下载到 `data/tts-models/`。

## 离线朗读（2026-11 定案，别再按模型名瞎试）

- 本地音色**只剩四个**：`melo` / `baker` / `xiao_ya` / `eula`。定义在 `src/shared/ipc.ts` 的 `OFFLINE_VOICES`，模型注册表在 `src/main/services/voice/offline.ts` 的 `MODEL_FILES`；加/换音色只改这两处。
- **baker 是 matcha 架构**：要单独的声码器 `vocos-22khz-univ.onnx`（`MODEL_FILES[id].vocoder`），下载流程会自动补；`resources/tts-offline-worker.cjs` 按 `request.kind` 分支构配置。
- 体检：`npx electron out/main/index.js --tts-offline-probe <melo|baker|xiao_ya|eula>`。判据是**预热后 p50 < 1.5 s**——首句含引擎加载，单独打成 `coldMs`，别混进 p50（混进去会随机红）。
- 实测 p50：baker 90 ms / xiao_ya 111 ms / eula 362 ms / melo 496 ms。
- 选型是听感说了算：这四个是用户亲耳挑的，804 人表的角色名（keqing / theresa）已被否，别再当卖点。
- 数据目录里现在有四个模型（`.tmp/tts/m` 那份是试听用的临时副本，可删）。

## 交接必须知道的几件事

- **数据目录已便携化**：安装版写 exe 同级 `data/`，`npm run dev` 与探针写项目根 `data/`；
  只有目标不可写才回落 `%APPDATA%`。入口在 `src/main/services/data-dir.ts` 的 `applyPortableUserData()`，
  必须在 `app.whenReady()` 之前调用。
- **不要 kill dota2**：用户常在打天梯。重启应用只杀 electron：
  `powershell -NoProfile -Command "Get-Process electron | Stop-Process -Force"`，然后 `npm run dev`。
- **提交规范**：英文 Conventional Commits，作者 `mystery4f <40482524+mystery4f@users.noreply.github.com>`。
- **改动后必跑**：`npm run typecheck`、`npm run lint`（只允许 2 条 `react-refresh` 警告）、`npm run build`。
- **探针**（改到哪块就跑哪个）：`--gsi-probe`、`--chat-block-probe`、`--translate-cache-probe`、
  `--settings-persist-probe`、`--overlay-geometry-probe`、`--match-report`。
- **当前分支**：`main`；最近提交见 `git log -5`。
