# 需求账本 2026-11（50 条候选）

出自 `/pm-brainstorm`（已有产品口径）与对 `src/main/services/`、`src/shared/`、面板十个 section 的逐模块盘点。
每条都写了「现状证据」与「期望」，证据是仓库里真实存在的模块或设置键；标「待核」的是我尚未实测、
实现前必须先验证现状的条目。

优先级口径：P0 = 现在就卡用户或卡我们判断；P1 = 一个迭代内该做；P2 = 有价值但不急；P3 = 想法，先不做。

## 取票与验收流程（2026-11-20 定，老板拍板）

- **不再由 PM 派单**。程序员自己扫 issue：`ready-for-agent` 里**号码最小的先做**（issue 编号即优先级），开工前在票上留一条认领评论。
- **关票权在他手上**：按 issue 的 Acceptance 自证，交付评论写清改了哪些文件、跑了哪些命令、结果，然后自己关票。
  PM 只抽查，发现证据不成立时回滚并重开票。
- **PM 不再私聊发需求**：需要 PM 判断的事（改口径 / 砍需求 / 调优先级）写进 issue 评论或新开一条，PM 扫的时候回。
- **`needs-triage` 由 PM 自己 triage**：翻成 `ready-for-agent` 或 `wontfix`（`wontfix` 必须写明理由），老板抽查即可。
- 新增、关闭一条需求时，**同一次改动里同步这份账本**；账本与 issue 不一致时以 issue 为准，并当天修账本。

已建 issue 的条目在末尾标注编号。空的表示仍在候选池，不动它就不会被误当成已承诺的工作。

## 一、上手与配置

- **空数据目录四步引导**（P0）——证据：`src/main/services/gsi-config.ts:160 ensureGsiConfig`、`src/main/services/voice/asr-model.ts`、
  `src/main/services/install-job.ts` 的单飞闸门。期望：Steam 路径 → GSI cfg → 识别模型 → 游戏内自检四步，每步给可点的验证动作与失败原因。进行中。
- **环境自检页**（P1）——证据：`src/shared/errors.ts`、`src/shared/voice-out-readiness.ts`、`src/main/services/session/warnings.ts` 已有零散警告。期望：一页列出 CPU/内存/磁盘余量/端口 32123 占用/设备数量，每行带「为什么需要」。
- **Steam 库多路径选择器**（P1）——证据：`libraryfolders.vdf` 解析在 `gsi-config.ts`，多库/移动硬盘时猜错就静默失败。期望：列出全部库，让用户点选，记住选择。
- **模型下载断点续传与镜像切换**（P1）——证据：`src/main/services/net/download.ts`。期望：中断可续，镜像可切，失败时说明是国内网络还是源本身。
- **首次对局影子模式**（P2）——期望：新用户第一局只记录不发声，赛后给一份「本可以听到这些」的样本，先建立信任再开语音。
- **配置导出/导入**（P2）——证据：`data/settings.json` 由 `applyPortableUserData()` 管理。期望：换机一键迁移设置与训练产物索引，不含密钥明文。

## 二、翻译质量

- **术语热更新包**（P1）——证据：`src/shared/dota-glossary.ts` 内置表 + `KEEP_VERBATIM_TOKENS`。期望：新英雄/道具词条独立于版本更新，装完即生效，坏包可回滚。
- **译后关键名词自检**（P1）——证据：`src/shared/translate-fidelity.ts` 只查拉丁缩写保真。期望：原文关键名词在译文里缺失时高亮，交给人判断，不做自动改写。
- **翻译方向自动判定**（P1）——证据：`TranslateDirection` 由调用方指定。期望：中英混排一行里按字符占比判定方向，判反了要能一键纠正并记住。
- **长句切分策略可配**（P2）——证据：`settings.translationMaxWords` 默认 16。期望：按标点/按字数两种策略，面板显示当前策略对译文的实际影响。
- **翻译 provider 失败矩阵**（P2）——证据：`src/main/services/providers/index.ts` 单 provider。期望：超时/限流/鉴权三类失败各有明确文案与重试节奏；跨 provider 降级必须显式提示，不许静默换模型。
- **每局译文抽查**（P2）——期望：对局内随手标记好/坏，落进评测集，之后用同一批句子比较两个 provider。

## 三、语音输出（我听别人说 / 我回话）

- **播报队列可视化 + 抢话打断**（P1）——证据：`src/main/services/voice/segment-player.ts`、`speech-pipeline.ts` 的 `applyBacklogPolicy`/`isSpeakStale`。期望：浮层显示「正在说 / 还剩 N 条」，一键停嘴并清队列。
- **音色包导出/导入互换**（P2）——证据：`src/main/services/voice/sovits-voicepack.ts`。期望：音色包成单文件，朋友间互换，导入前校验参考音频与文本齐全。
- **虚拟声卡一键安装**（P1）——证据：`src/main/services/voice/virtual-cable-install.ts`、`virtual-cable.ts`。期望：检测缺驱动时给一条明确路径，装完自动选中，失败说清是哪一步。
- **播报设备热切换不断流**（P2）——证据：`settings.ttsOutputDevice`。期望：切设备不打断当前句，切换失败回到原设备并提示。
- **语速自适应长句**（P3）——证据：`settings.ttsRate`。期望：超过 N 字的句子自动提速，别让一条长句堵住后面。
- **按玩家的朗读开关**（P2）——证据：`settings.ttsReadOwn`（自己）与 `ttsDropBacklog`。期望：按玩家/阵营单独开关，别只有「自己」一个维度。

## 四、语音输入（对讲）

- **双引擎短句路由**（P1）——证据：`src/shared/asr/engines.ts` 两引擎（qwen3 / paraformer），`resources/asr-sherpa-worker.cjs:82` 缓存键含引擎与热词。期望：短句走快的、长句走准的，路由规则可关；不做两路并行（显存/CPU 代价不明）。
- **对讲三态单点反馈**（P1）——期望：待机/录音/播报 一个环状指示，替代现在的多行文案，打团时不用读字。
- **按住说话热键自检**（P1）——证据：`src/main/services/input/hotkey-hold.ps1`、`hotkey-hold.ts` 的 5 次重启与降级。期望：面板上一按就能看到 `HOLD 1/HOLD 0` 是否到达，降级到 `globalShortcut` 时明确告知。
- **录音设备健康与音量表**（P1）——证据：`src/shared/mic.ts`、`settings.micDevice`。期望：录音时实时电平，设备掉线立刻提示并回退到默认，不静默录出空 wav。
- **静音阈值可调**（P2）——期望：句尾判定时间可配，打团短促说话与慢速长句给两套预设。
- **识别结果可编辑后重播**（P2）——期望：对讲结果在浮层里可改字再播，改过的句子进纠错样本。

## 五、浮层

- **打团一句话结论**（P1）——证据：浮层现在是逐条译文（`src/renderer/src/overlay/chat-rows.tsx`、`settings.overlayText` 三态）。期望：新消息先给一条短结论，展开才看原文与逐条译文。
- **字号与对比度无障碍**（P1）——证据：`src/renderer/src/overlay/overlay.css`。期望：三档字号、色弱安全配色、对比度不低于 AA，全部不依赖颜色单独表达状态。
- **多显示器位置记忆**（P2）——证据：`settings.overlayBounds` 单份几何。期望：每台显示器各记一份，拔显示器后回到主屏且不越界。
- **有译文才淡入**（P2）——期望：空闲时降到极低存在感，来消息淡入，避免长期遮挡血条。
- **浮层纯键盘可操作**（P2）——证据：`overlayPanel` 召唤面板已是交互态。期望：Tab/方向键/回车走完历史、快捷短语、建议三块，不要求鼠标。

## 六、训练（音色 / 识别）

- **数据集质量体检**（P1）——证据：`src/main/services/train/ft-dataset.ts`、`ft-record.ts`、`resources/asr-ft-script.md` 的 `Gxx` 分组。期望：重复句、静音段、时长分布、缺失行一次列清，说完再开训。
- **训练后自动 A/B 试听**（P1）——证据：`src/main/services/train/run-metrics.ts` 只回读指标，`asrFtSwapSteps` 自动 promote。期望：新模型与现役对同一句录音各出一份结果，听过再决定是否换。
- **训练失败诊断页**（P2）——证据：`src/main/services/train/log-file.ts`、`docs/adr/train-crash-reconcile.md`。期望：从日志里抽出失败阶段与一句人话原因，而不是让用户贴日志给我们。
- **训练队列**（P2）——证据：`src/main/services/train/manager.ts` 单跑。期望：多条 run 串行排队，队列可见可取消。
- **磁盘配额与清理提示**（P2）——证据：`pruneAsrFtRunDirs`、`docs/adr/asr-ft-run-retention.md`（每个 run ~15 GB）。期望：开训前显示预计占用与保留策略，空间不足就近拒绝。
- **数据集版本号**（P3）——期望：一套录音一个版本号，训练记录里能指回具体版本。

## 七、观测与运维

- **面板「本周质量」卡片**（P1）——证据：`logs/translate-guard.jsonl`、`logs/translate-cache.jsonl` 已落盘，面板不展示。期望：抓到多少次违例、救回多少、命中率多少，一个卡片看完。
- **日志一键打包导出**（P1）——证据：`logs/` 下 `inplace.log`、`gsi-chat.jsonl`、`gsi-summary.json`、`voice-chain.jsonl`、`capture-ticks.jsonl` 五个来源。期望：一次导出成一个带清单的压缩包，含版本号与 BUILD_STAMP，敏感字段（昵称、设备 id）默认脱敏。
- **探针结果面板化**（P2）——证据：`src/main/probes/registry.ts` 33 个探针。期望：面板能跑只读探针并显示结果，省掉「贴命令给我」这一轮。
- **版本漂移提示**（P2）——证据：`BUILD_STAMP` 每次主进程构建打印。期望：`out/main/index.js` 比源码旧时提示「改的代码没生效」，这是最容易误判的一类假 bug。
- **provider 延迟与失败率看板**（P2）——证据：`src/main/services/session/translator-latency.ts`。期望：按 provider 展示 P50/P95 与失败分类，帮用户自己选 provider。
- **本地异常汇总**（P3）——证据：`src/shared/errors.ts`。期望：把未捕获异常收成一个可导出的清单，不联网上报。

## 八、效率与生态

- **历史搜索**（P1）——证据：召唤面板 200 行历史（`summon-panel.tsx`）。期望：按玩家名/关键词过滤，命中即复制。
- **快捷短语分组与变量**（P2）——证据：`settings.quickPhrases` 平铺数组。期望：分组、占位变量（英雄名/时间），发之前预览。
- **局内打星**（P2）——证据：与复盘页同一批数据（依赖 #73）。期望：对局内给某句话按一下星，赛后复盘优先显示。
- **分享战报图**（P2）——证据：同上。期望：一局一张图，含「听懂了 N 条 / 误译 M 条 / 起播中位 X ms」。
- **第二目标语言**（P3）——证据：`settings.targetLang` 单值。期望：主语言外再挂一个，用于多国队友。
- **同局语伴画像**（P3）——期望：同一玩家在本局的称呼与语气保持一致，复用他的历史译文，减少重复上下文。

## 下一步

候选池里 P0/P1 共 16 条，其中 6 条已建 issue（见各条标注）。程序员手上是 P1-3 与后续交付，
本账本的作用是：他做完手上的，按优先级从这里取票，而不是我口头派单。

新增或关闭一条，必须回来改这份账本；账本与 issue 不一致时以 issue 为准，并当天修账本。
