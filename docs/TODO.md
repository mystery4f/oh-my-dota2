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

## 待办（按优先级）

- `#1` GSI 正文可靠性：一局真实天梯里 `gsi-chat.jsonl` 的行是否齐全、去重后条数、与浮层实际上屏条数是否对得上
  （`--match-report` 已改为只读 GSI 日志 + 账本，OCR 时代的 tick 指标随 OCR 一起删了）
- `#2` 账本覆盖率复核：`--match-report` 的 `ledgerCoverage` 在 `chatSource=gsi` 下是否还有意义，没有就删掉这段
- `#3` `POST_GAME` 自动停捕获 + 下一局自动拉起（`--gsi-probe` 已离线覆盖，缺真对局确认）
- `#7` 同一句高频重复时浮层合并成一行并标注 ×N（只改渲染层）
- `#9` 行点击复制原文
- `#10` 浮层滚动历史（上翻看旧句）
- `#11` `Alt+Shift+X` 清屏
- `#12` 局末战报：`POST_GAME` 时汇总本局数据
- `#13` 事件提醒：击杀 / 肉山 / 符点用朗读播报
- `#14` 敌方关键装备提醒
- `#15` 指挥类消息高亮
- `#16` 快捷短语一键发送
- `#17` BP 阶段阵容中文名提示
- `#18` ~~把 OCR 从默认包里摘出去~~（已彻底删除，可关闭）
- `#19` 朗读改流式播放（用户 m08388 要求先记录，未开工）
  - 现状：`src/main/services/voice/edge.ts` 的 `synthesize()` 走 `toBuffer()`，**整段合成完才返回**，
    实测 700–1639 ms（12 次采样，p50 ≈ 1.2 s）；`speech.ts` 的 `deliver()` 拿到完整 Buffer 才下发播放。
    感知延迟 = 合成总时长，而不是首字时间。
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
- `#20` 离线引擎（**已完成**，2026-11）：最终形态见上面「离线朗读（2026-11 定案）」一节——四个音色 `melo` / `baker` / `xiao_ya` / `eula`，`sherpa-onnx-node` 跑在系统 node 子进程里。
  - 选型过程留档，别再重复试：`vits-zh-aishell3` 只有 8 kHz；`kokoro-multi-lang-v1_1` 要 jieba + 词典 + FST，RTF 1.3–2.7 最慢；`baker` 先因音色被否、后又被留用；`melo` 44.1 kHz 最好听但每句重载 183 MB，冷启动 5 s。
  - 运行时铁律：Electron 的任何运行时（包括 `ELECTRON_RUN_AS_NODE`）都会抛 `External buffers are not allowed`，只有系统 `node.exe` 子进程能跑 sherpa。
  - 模型不进安装包（只为体积），首次选音色时下载到 `data/tts-models/`。
- `#21` baker 的声码器在**安装版**首次下载没验证过：`vocos-22khz-univ.onnx`（53 MB，放 `tts-models/` 根目录，四个音色共用）只在 dev 用户态跑过，安装版写的是 `G:\oh-my-dota2-data\tts-models\`。
  - 验收：安装版把引擎切「本地模型」选 baker，看到下载日志 → 模型就绪 → 出声；弱网可先手动把 onnx 丢进该目录，程序检测到就不下。
- `#22` Edge **分句流式**已实现但没测过数字：`splitForSpeech`（≤20 字按标点切）+ 并行合成 + 顺序播放（commit `fb496da`），`SPEAK_QUEUE_MAX` 已从 3 提到 6。
  - 缺的是基线：首段延迟、整句延迟、失败率都还没跑（`--tts-bench` 要独占实例，dev 应用持有单实例锁）。
  - 验收：关掉 dev 应用后 `npx electron out/main/index.js --tts-bench`，首段 p50 应明显低于整句 p50。

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
