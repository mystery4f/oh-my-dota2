# 原型 → 落地：剩余十二屏的落差表（2026-11-21）

用途：原型（`src/renderer/src/prototype/shell/pages/`）里还有一批屏在真面板上没有对应形状。这张表逐屏列四列——**原型位置 / 真面板现状 / 数据来源 / 缺什么**——给下一轮排落地顺序用。

「缺什么」只有三种取值，别的词一律不用：

- **数据缺**：要显示的那件事在主进程里根本没有可信来源（谁也没有写入者、或只有 console）。
- **通道缺**：数据在，但没有 IPC 通道把它送到渲染层。
- **只是没画**：数据与通道都齐，缺的只是把形状画出来。

> 判据：`grep` 一遍调用点比读设计文档快。凡写「数据齐」的行，都能在那个 `文件:行` 上看到真调用。

## 一张纸的结论

- **数据缺（先补数据再谈形状）**：快捷短语**分组**（`quickPhraseGroups` 在 #159 已删——全仓零写入者）；识别训练的**结局/指标**里「这一轮最终怎样」那一行（`runs.metrics` 有数字，但「结局」需要一个 `TrainRun.status` 到人话的映射，现在只在面板里临时拼）。
- **只是没画（数据与通道都齐，随时能落）**：其余十屏——talk、read、overlay、chatout 主体、engine、voice（音色训练）、asr 主体、hotkeys、about、wire、packs、board。
- **通道缺**：本次逐屏走完**没有新增**。`matchTimeline()`（#162）落地后 wire 与 helm 都能直接读。

## 逐屏

### talk（它怎么听 · 说）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/talk.tsx`（294 行，12 组行） |
| 真面板现状 | `src/renderer/src/panel/pages/talk.tsx`（916 行）：怎么听 `:344`、识别引擎 `:388`、语音运行时 `:403`、说话键 `:421`、识别模型 `:472`、说给谁听 `:499`、声出音色 `:523`、切段策略 `:562`、影子模式 `:579`、本机也播放 `:620`、输出设备 `:629`、这条链走到哪 `:676`、语音队列 `:686` |
| 数据来源 | `settings`（`@shared/settings-shape`）＋ `voice:out-readiness`、`voiceOut:shadow`、`asrStatus()`、`hotwordSuggestions()`、`voiceOutCable/Install`（`src/main/services/voice/*`） |
| 缺什么 | **只是没画**。原型少画的是后来才有的四块：语音队列（#88）、热词候选（#74）、虚拟声卡缺口（#90）、这条链走到哪（#140 的 `note` 槽） |

### read（它怎么念）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/read.tsx`（269 行，11 行） |
| 真面板现状 | `src/renderer/src/panel/pages/read.tsx`（390 行）：开关 `:86`、朗读新消息 `:87`、对局播报 `:98`、逐条开关 `:112`、引擎与嗓子 `:135`、语速 `:195`、离线模型状态 `:351` |
| 数据来源 | `settings.tts*`、`settings.announce*`、`offlineUiView()`（`src/shared/offline-status.ts`）、`speak-skip` 行（`logs/voice-chain.jsonl`） |
| 缺什么 | **只是没画**。原型缺「对局播报四按钮 + 总开关」「离线模型三态」「悖论式文案（就绪优先于上一轮 error）」三处 |

### overlay（屏幕上那一层）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/overlay.tsx`（203 行，12 行） |
| 真面板现状 | `src/renderer/src/panel/pages/overlay.tsx`（245 行）：显示 `:61`、窗口 `:62`、外观 `:106`、底色深浅 `:107`、**字号 `:123`**、位置 `:170`、当前几何 `:171`、对局 `:178`、开机自动捕获 `:179`、锁定与截图 `:240`、热键 `:241` |
| 数据来源 | `OverlayStatus`（`overlay:*` 通道）、`overlayFontScale()`（`src/shared/overlay-a11y.ts`）、`planBounds()`（`src/shared/display-geometry.ts`） |
| 缺什么 | **只是没画**。原型没有字号三档（#100 已落 `FONT_SCALE`）与 `overlayDigest` 的说明行 |

### chatout（直发）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/chatout.tsx`（187 行，6 行） |
| 真面板现状 | `src/renderer/src/panel/pages/chatout.tsx`（206 行）：文字出口 `:81`、原地直发 `:82`、现在就发 `:85`、语气 `:100`/`:101`、跨语气查词库 `:115`、快捷短语 `:125`/`:126` |
| 数据来源 | `settings.inplace*`、`settings.tone*`、`settings.quickPhrases`、`quickPhrases` 经 `OverlayStatus` |
| 缺什么 | 主体**只是没画**（原型缺「语气」「跨语气查词库」两行）；**短语分组 = 数据缺**——`quickPhraseGroups` 已在 #159 删除，全仓零写入者，分组形状要等真有数据再说 |

### engine（翻译引擎）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/engine.tsx`（318 行，13 行） |
| 真面板现状 | `src/renderer/src/panel/pages/engine.tsx`（549 行）：服务 `:70`、预设 `:71`、**密钥 `:118`**、模型 `:137`、代理 `:146`、连通性 `:176`、输出 `:184`、浮层译文语言 `:185`、缓存 `:232`、质量 `:251`、词表 `:268`、试验台 `:494` |
| 数据来源 | `settings.provider*`、`settings.targetLang/targetLang2`（`src/shared/target-language.ts`）、`providers:board`、`judgeProviderFailure()`（`src/shared/provider-failure.ts`）、`translationMarks()` |
| 缺什么 | **只是没画**。原型缺「中→外与外→中两个方向各自的目标语言」（#120）与独立的密钥行 |

### voice（音色训练）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/voice.tsx`（165 行，8 行） |
| 真面板现状 | `src/renderer/src/panel/pages/voice-train.tsx`（244 行）：训练版本 `:80`、webui `:152`、运行 `:172`、训练记录 `:176`、产物 `:189` |
| 数据来源 | `tts:sovits-ft-status`、`tts:sovits-voices`、`sovitsVoicepacks()`、`logs/sovits-*.jsonl` |
| 缺什么 | **只是没画**。原型那 8 行里「实验 / 历史 / 注册为音色包」要等音色包页（packs）一起定形状 |

### asr（识别训练）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/asr.tsx`（462 行，25 行；28 个 Row） |
| 真面板现状 | `src/renderer/src/panel/pages/asr-train.tsx`（913 行）：Python 与依赖 `:412`、还缺的依赖 `:416`、安装 `:425`、句子 `:504`、识别结果 `:597`、数据体检 `:663`、打包数据集 `:678`、全量识别比对 `:701`、预计耗时 `:759`、训练记录 `:788`、试听对比 `:823`、最近导出 `:874`、**短句/长句分流 `:864`** |
| 数据来源 | `ft:asrft-status`、`runs.db`（`src/main/services/train/run-store.ts`）、`cer.ts`（CER 三队列）、`--train-probe`/`--asr-check-live-probe` |
| 缺什么 | 主体**只是没画**（左轨四步与六态头条）；两处**数据缺**：「结局」需要 `TrainRun.status → 人话` 的映射（面板临时拼的，不在 `src/shared/train/run.ts` 里）；「指标」只在 `runs.metrics` 里，没有一份「哪个指标代表什么」的口径 |

### hotkeys

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/hotkeys.tsx`（207 行，5 行） |
| 真面板现状 | `src/renderer/src/panel/pages/hotkeys.tsx`（272 行）：动作键位 `:138`、语音对讲怎么按 `:191`、**按住检测 `:214`**（#95）、键位冲突 `:231`、整表 `:240` |
| 数据来源 | `hotkeys:get`/`hotkeys:set`、`hotkey:hold-selftest`、`judgeHoldHealth()`（`src/shared/hold-selftest.ts`） |
| 缺什么 | **没有缺**。这一屏原型与真面板已对齐，只差视觉 |

### about

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/about.tsx`（149 行，14 行） |
| 真面板现状 | `src/renderer/src/panel/pages/about.tsx`（253 行）：版本 `:109`、当前版本 `:110`、构建时间 `:128`、诊断 `:137`、**回声 `:139`**、**模型调用 `:149`**、**探针清单 `:167`**、**最近的错误 `:185`**、导出诊断包 `:221`、导出设置包 `:227`、导入设置包 `:233`、文档 `:240` |
| 数据来源 | `errors:view`、`providers:board`、`probes:catalog`、`voice:half-duplex`、`translation:marks`、`diagnostics:log-bundle` |
| 缺什么 | **只是没画**。原型缺四行诊断（回声 / 模型调用 / 探针清单 / 最近的错误）与译文抽检一行——都在真面板里 |

### wire（这台机器的接线）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/wire.tsx`（151 行，七段） |
| 真面板现状 | 没有独立页：`src/renderer/src/panel/pages/overview.tsx` 的「上手检查」`:271` 与「这台机器」`:317`（#77/#88），外加异常组 `:248`（GSI 断流 #75） |
| 数据来源 | `env:report`（`judgeEnv()`）、`gsi:libraries`/`gsi:set-library`（`resolveGsiRoot()`）、`first-run:report`（`judgeFirstRun()`） |
| 缺什么 | **只是没画**（形状分散在总览两处）。要不要独立成页是设计面，等 pm 定 |

### packs（音色包）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/packs.tsx`（409 行，10 行） |
| 真面板现状 | 不是页，是弹窗：`src/renderer/src/panel/components/voice-pack-dialog.tsx`（从库里选 `:179`、参考音频的细节 `:239`、野路径 `:262`、引擎与地址 `:276`、服务地址 `:285`、运行状态 `:295`） |
| 数据来源 | `tts:sovits-voicepacks`/`-install`/`-delete`、`sovits:server` |
| 缺什么 | **只是没画**（原型把它升成页）。弹窗里已有的六段数据全在；缺的是「清单本身」这一屏级视图 |

### board（副屏）

| 列 | 内容 |
| --- | --- |
| 原型位置 | `src/renderer/src/prototype/shell/pages/board.tsx`（196 行） |
| 真面板现状 | 已落地为独立窗口：`src/renderer/src/board/board-app.tsx`（`boardView(snapshot, now)` 在 `:39`）+ `src/main/windows/board.ts` |
| 数据来源 | `match:snapshot`（`src/shared/match-snapshot.ts`）、`boardView()`（`src/shared/board-view.ts`） |
| 缺什么 | **没有缺**（#124a 已落）。原型里的呼吸灯与动效是纯视觉项 |

## 怎么用这张表

- 排落地顺序前先看「缺什么」那一列：**数据缺**的两处要先补数据（短语分组先决定 `quickPhraseGroups` 要不要回来；识别训练的「结局/指标」先落一份口径），其余十屏可以随时按设计稿画。
- 每屏落地仍走同一套：纯判断进 `src/shared/*`（页面里不许出现 `if (matchid === '0')` 这类判断）、一个 ci 探针钉形状、面板页面只渲染。
- 这张表是**快照**：任何一屏落地后，把对应行改成实际 `文件:行`，别让下一轮再猜。