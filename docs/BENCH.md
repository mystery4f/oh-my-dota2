# 测试与基准（probes & benches）

这个工程的「测试」不是单元测试套件，而是一组**可重复运行的探针**：每个探针都是一条真实链路（Electron 主进程 + 真实模型 + 真实屏幕/语音），跑完打印一行 JSON 并以退出码表示通过与否。它们常驻仓库，随代码一起演进。

## 两类工具

| 类型 | 位置 | 怎么跑 | 用途 |
| --- | --- | --- | --- |
| 探针（probe） | `src/main/selftest.ts`，路由在 `src/main/index.ts` | `npm run probe -- --<name>` （需先 `npm run build`） | 断言业务行为，通过/失败可判定 |
| 基准（bench） | `scripts/bench-ocr.mjs` | `npm run bench:ocr` | 只量数字，用于对比优化前后 |

探针只在你显式传 `--xxx-probe` 时运行；正常启动完全不受影响（`src/main/index.ts` 里有 `probeRun` 判定，探针期间也不会自动开捕获）。

## 探针清单

| 探针 | 断言什么 |
| --- | --- |
| `--capture-selftest` | 截图 → OCR → 去重 → 翻译 → 浮层，端到端跑通 |
| `--latency-probe` | 往聊天区画一条新消息，量「原文上屏」与「译文上屏」的毫秒数（两轮：冷启动 + 稳定态） |
| `--grab-probe` | `desktopCapturer.getSources` 在不同缩略图尺寸下的抓屏成本 |
| `--stream-grab-probe` | 常驻视频流取帧的首次与稳态耗时（对比 getSources） |
| `--fingerprint-probe` | 半透明面板背后画面在动时，灰度判据 vs 亮点判据的误触发量（合成场景） |
| `--motion-probe` | 采样真实聊天区的灰度/亮点变化比例（需要游戏在跑，一边动镜头一边看） |
| `--capture-telemetry-probe [秒数]` | 自动模式实跑若干拍，断言每拍都留了遥测（`grabMs` 齐全、无 `error`、文件 <1MB），并打抓屏/判定/OCR 的 p50 与真实节奏；跟秒数就是跟一局 |
| `--gsi-probe` | GSI 判定与链路：9 个纯判定用例（翻转语义、缺字段不误判）+ 真实 HTTP 推一串 payload；另断言「局末停捕获只对自动模式生效」 |
| `--gsi-dump [秒数]` | 把这几分钟里 Dota 推的每个字段路径摊开（类型/次数/示例值）写到 `logs/gsi-frames.json`，扩 `data` 段之前先看真实密度；跑之前先关 dev 应用（端口单占） |
| `--gsi-dump-report [文件]` | 读应用边打边记的 `logs/gsi-summary.json`，直接给结论：真对局还是训练场、`allplayers` 到底给不给、出现过哪些 `event_type`。只读，dev 应用开着、刚打完一局都能跑；两个 userData 目录都看，取最新的那份 |
| `--match-report [日志目录] [--since-min N]` | 一局的成绩单：GSI 独立句子数与重复帧分布、逐拍动作分布、抓屏/OCR 分位、节奏空档、`fresh`/freshRatio、`brk`/`rst`，再把「GSI 收到的句子」与记账本对账，列出没进翻译的正文。只读日志，对局中也能跑 |
| `--settings-persist-probe` | 面板上选过的值活过一次重启：逐项写哨兵值再读回、连续写入互不覆盖、残缺/含未知键的文件按字段回落默认、跑完原样还原 |
| `--overlay-geometry-probe` | 浮层几何与交互规则的纯算术（23 项）：小于最小尺寸被抬起、拖出左右边界各留 80 px 还能抓回来、拖动整体平移、拉右把手只改宽、拉左把手右边缘钉死、贴边时宽度下限优先、距边 <24 px 才吸附、收起后的小图标在没换显示器时保持不动；另钉住两条改错过两次的规则：`shouldIgnoreMouse(locked, replyOpen)`（只有「锁定且不在回复」才穿透，收起也一样）与 `shouldAutoLock` |
| `--tts-offline-probe` | 离线引擎实测：3 句中文走 MeloTTS（`sherpa-onnx` + 子进程 node），打印每句毫秒/字节，并断言三个音色预设合成的字节数互异。基线 **3/3 成功、首句 ≈5.5 s（含子进程与引擎加载）、之后 p50 0.37–0.80 s**，判据 p50 < 1.5 s。找不到 `node` 会直接判红并打印 `TTS_OFFLINE_NO_NODE` |
| `--tts-bench [n]` | 朗读链路的实测：n 句中文（默认 10）走 Edge 神经语音，打印 `ok/failed/p50/min/max` 毫秒与字节数，另断言 `pitchOk`——同句同嗓用 0.75 / 1.25 两个音高合成出来的字节数必须不同（否则「音高滑杆」是假的）。本机基线 **10/10 成功、p50 ≈ 0.8–1.2 s**（改造前同一台机器 6 句里 4 句 429、冷握手 1–21 s）。连串 429 或 0 字节说明免费端点限流；`ms≈0` 反而是参数被本地校验拒绝 |
| `--translate-cache-probe` | 翻译记账本：一次翻译存一对、两个方向都能命中、中文答案不许冒充英文、反向着不认语气、统计字段（方向/来源/字符数/词数/命中数）落地、关句柄重开后仍在（15 项） |
| `--manual-probe` | 手动触发：整屏重建不重复追加、缓存命中（第二次明显更快且缓存条数不变） |
| `--chat-block-probe` | 续行合并、行内拆分、真实客户端昵称前缀、滚动去重 |
| `--reply-tone-probe` | 四种语气的英译互不相同且 ≤8 词 / ≤80 字符 |
| `--reply-draft-probe` | 面板草稿落盘、倒计时、历史回填 |
| `--reply-overlay-probe` | 浮层回复栏：热键打开、回车发送、剪贴板、草稿保留 |
| `--accuracy-probe` | 12 条固定语料的译文质量（含回声、元语言、重复句检测） |
| `--inplace-probe` | 常驻输入桥的启动耗时与往返延迟（只 ping，不碰游戏窗口） |
| `--reply-latency-probe` | 预热会话后连跑四句回复翻译，量中位/最大耗时与对冲是否生效 |
| `--fuse-probe` | 慢回合熔断：12 秒超时后回退直连且结果正确 |
| `--session-probe` / `--raw-session-probe` | 持久翻译会话的往返与请求体（排查模型侧问题） |
| `--whisper-assets-probe` / `--transcribe-probe` | whisper.cpp 资源下载与中文/英文转写 |
| `--voice-ui-probe` | 浮层录音链路（静音守卫、识别文案） |
| `--region-probe` / `--overlay-probe` / `--highlight-probe` | 框选区域、浮层绘制、区域高亮 |
| `--overlay-probe`（文字层次） | 喂一条待翻译消息再补译文，断言四种视图：待翻译时原文可见且无译文（先上屏不空等）、`translated` 只留译文、`both` 两层都在、`original` 只留原文；末尾 `textLayerOk` 为真才退出 0；同一探针还喂一条「进了队列却没翻成」的行，断言浮层出现 `.trans.err`（文字 `✕ 翻译失败`、`title` 带原始报错），`errorOk` 与 `heroOk` 也必须为真 |
| `--try-probe` | 翻译试用页走独立会话槽 |
| `--overview-probe` | 面板总览卡渲染 |

## 当前基线（2026-10-23，Ryzen 20 核 / 2560x1440@1.5）

```
OCR（1935x937，6 行聊天）
  onnxruntime 默认线程  1920 ms
  6 线程                 837 ms
  6 线程 + 0.57 缩放     428 ms

抓屏
  desktopCapturer.getSources  全屏物理像素约 950 ms（缩略图尺寸几乎不影响，瓶颈在捕获通道）
  常驻视频流（--stream-grab-probe）  首帧 1232 ms（含窗口与流启动），之后 12-21 ms/帧

端到端（--latency-probe，轮询 800 ms，round2 = 稳定态）
  消息出现 → 原文上屏      约 1.2-1.6 s（抓屏 60 ms + OCR 0.5-0.7 s + 轮询相位 ≤0.8 s）
  消息出现 → 译文上屏      2.7-6.6 s（模型首字节抖动 1-9 s；会话 5 秒未回则对冲直连）
  画面未变跳过              每次约 60-80 ms（64x36 灰度指纹，变化格数 >1.5% 才 OCR）

直发（Alt+Shift+T → 原地替换聊天框）
  输入桥启动（--inplace-probe）  569-693 ms，只在启动预热付一次；之后往返 1-2 ms
  读聊天框                        约 0.3 s（查进程 0-46 ms · 写哨兵 0 ms · Ctrl+A/Ctrl+C 260-290 ms；清空输入框挪到返回之后并行掉）
  写回并回车                      约 0.35 s（查进程 0-16 ms · 写剪贴板 0 ms · Ctrl+A/Ctrl+V/Enter 310-350 ms）
  组合键时序                      按住 20 ms + 间隔 25 ms（一次组合 85 ms）；首轮被丢会慢速重试一次，inplace.log 记 retried
  回复翻译（--reply-latency-probe，预热后）  热 676-988 ms（中位 867 ms），冷 889-4475 ms（1.8 s 未回则对冲直连）
  合计                            约 2.2 s（改前：两次 spawn 各 0.6-0.7 s + 等待 1.7 s + 首句 7.9 s）
```

## 自动捕获逐拍遥测（2026-11，同一台机器）

每一拍都往 `logs/capture-ticks.jsonl` 写一行（单文件上限 1 MB，超限清空重写），所以数字不用再靠猜。`--capture-telemetry-probe` 在桌面上实跑的结果：

```
12 拍（11.6 s 预算）      拍数 10 · actions {ocr:6, gap:3, same:1} · 全部 src=stream
  grabMs                  p50 70 / p90 183 / max 548
  changePct               p50 0.0113 / max 0.0825（桌面图标一直在变，误判为「变了」）
  ocr p50Ms               749 · lines [4,4,5,3,1,0] · fresh [3,0,4,2,0,0]

45 拍（45 s 预算）        拍数 40 · cadence p50 809 / max 5190 · actions {ocr:6, same:34}
  grabMs                  p50 72 / p90 89 / max 612
  changePct               p50 0 / max 0.0777（画面静止时指纹判定 34 拍全跳过，符合预期）
  ocr p50Ms               2207 · fresh [3,1,0,0,0,0]
```

两条结论：

- **节奏不是问题**：轮询间隔设 800 ms 时实测 cadence p50 = 809 ms，抓屏 70 ms 一帧，`busy`（重入）为 0。
- **OCR 是唯一的天花板**：单次 315 ms – 3680 ms，暖机后常见 2.0-2.3 s，凡是 OCR 那一拍节奏就会被拖到 2-5 s。所以自动模式的实际上限是「每 1.5-2.5 s 读一屏」，跟间隔设成 800 ms 还是 500 ms 没关系。

### 游戏内实跑（2026-11，Dota 2 试用英雄，捕获区 934x206，scaleFactor 1.5）

dev 应用切「自动」，用户进游戏后采集 45 拍 / 72 s：

```
拍数 45 · span 72 s · actions {ocr:19, gap:26} · same 0 次 · 全部 src=stream
cadence                 p50 801 / p90 802 / max 37113（其中 37 s 是中断，见下）
grabMs                  p50 202 / p90 277 / max 319
ocrMs                   p50 268 / p90 431 / max 1066
changePct               p50 ~0.23 / max 0.997 · need 被抬到 0.0015→0.0045
lines 1-6 · fresh 0-4 · dup 0 · own 0 · brk 峰值 1（未触发清屏）
```

三条和桌面完全不同的结论：

- **常驻流没掉**：45 拍全是 `src=stream`。桌面那套「全屏独占导致 WGC `E_FAIL`、`sources` 兜底 300-900 ms」的担心，在游戏前台时没有出现（至少窗口化/试用英雄场景）。
- **OCR 不再是最慢的一环**：p50 268 ms，桌面是 2207 ms。原因是捕获区小了一圈（934x206 vs 1066x271）且场上没几句中文。**抓屏变成新的瓶颈**：p50 202 ms，桌面 72 ms、空闲 29 ms，慢了近 3 倍 —— 游戏在前台时 `getUserMedia` 抽帧要等 GPU 让出时间片。
- **指纹在游戏画面里基本失效**：`same` 0 次，`changePct` 常在 0.2-1.0（菜单/技能面板一开就是 0.99），阈值被自动抬到 0.0045 也拦不住。真正干活的是 `ocrGap` 退避：没新消息 → `noNewStreak` 涨 → 下一次 OCR 间隔从 800 ms 拉到 1.3 s / 1.8 s / 2.3 s …，所以 72 s 里只 OCR 了 19 次。

另一件事：01:19:55 → 01:20:33 之间有 37 s 没有任何一拍，前后都是稳定 801 ms。数据里没有任何 `busy`、没有超长 `ocrMs`（max 1066），所以不是卡在某次 OCR 里；最可能是用户在这段里 stop/start 过捕获（面板操作）。复现方式不定，先记着。

顺带验证了两种 OCR 入参形态（同一张 1600x406、12 行合成图，各 5 次）：

```
写 PNG 文件 + detect(path)   中位 1129 ms
raw buffer + detect(input)   中位 1184 ms   ← 省不掉什么，不必改调用形态
缩到 1072x272                中位  920 ms   ← 只省 18%，但 gg wp→ggwp、[LISA.]: 空格丢失
缩到  800x203                中位  899 ms   ← 文字进一步粘连，不划算
```

### 真对局（2026-11，15.6 分钟 / 383 拍，捕获区 1066x271）

用户在真实对局里边打边采（面板「自动捕获」，间隔 800 ms），数据从 `logs/capture-ticks.jsonl` 读出，剔除重启造成的断电段后：

```
跨距              17:19:54 → 17:35:31（15.6 min）· 383 拍
cadence           p50 801 / p90 803（目标 800，达标）
grabMs            p50 185 / p90 289 / max 612 · 全部 src=stream
ocrMs             p50 216 / p90 526 / max 3680
actions           {ocr:98, gap:142, same:68, busy:75}   ← 修复前的数字
新消息 29 条 · dup 0 · own 0 · brk 从未触发 · err 0 · rst 0
```

两条结论：

- **抓屏 p50 185 ms、OCR p50 216 ms，都落在可接受区间**。桌面上那个「OCR 单次中位 2.2 s」的结论只适用于桌面（捕获区里塞满中文那几句），对局里根本不存在。原先「自动模式每 1.5-2.5 s 才能读一屏」的估计偏悲观，实际接近每秒一拍。
- **`busy` 75 次是 bug，不是性能**。日志里成对出现的记录时间戳完全相同（`38.459 busy` / `38.458 gap`），说明有两条定时器链在同时跑：`busy` 分支自己调了一次 `scheduleNext()`，`finally` 里又调了一次，每撞一次 busy 就多出一条链。修掉之后（`scheduleNext()` 先 `clearTimeout` 兜底 + 删掉重复排程）重启复测：

```
修复前  25 拍 / 20 s：acts {gap:19, ocr:5, same:1, busy:30/60} · cadence p50 0（成对撞毫秒）
修复后  25 拍 / 20 s：acts {gap:19, ocr:5, same:1, busy:0}     · cadence p50 801 / p90 802
```

## 离线朗读引擎（2026-11，Ryzen 20 核）

选型实测（同一台机器，同一句，纯 Node 推理，5 次取中位）：

| 模型 | RTF | 每句 | 备注 |
| --- | --- | --- | --- |
| matcha-icefall-zh-baker | 0.09–0.13 | 81–193 ms | 快，但只有 22.05 kHz、音色发闷——用户当场否掉 |
| **vits-melo-tts-zh_en** | **0.19–0.41** | **371–801 ms** | **选用**：44.1 kHz，中英混读，音质明显更好 |
| vits-zh-aishell3 | — | — | 174 个说话人，但只有 **8 kHz**（电话音质），淘汰 |
| vits-zh-hf-theresa | 0.09–0.10 | 80–118 ms | 同样可用的备选 |
| vits-melo-tts-zh_en | 0.5–1.1 | 460–2700 ms | 中英混读更强，但慢一个量级 |
| vits-zh-hf-fanchen-C | 0.85 | 670–1033 ms | 一般 |
| kokoro-int8-multi-lang-v1_0 | 1.3–2.7 | 1180–2700 ms | 最慢，且要 jieba + 词典 + FST，已否决 |

接入后的端到端（`npx electron out/main/index.js --tts-offline-probe`）：

| 项 | 数值 |
| --- | --- |
| 首次（子进程启动 + 引擎加载 + 首句） | 2433 ms |
| 稳定后每句 p50 | 111–249 ms |
| 输出 | 22.05 kHz / 16 bit / 单声道，约 72 KB/句 |
| 对照：Edge 神经语音 | p50 1186 ms |

前置条件：本机要有 `node`（`sherpa-onnx` 的原生插件在 Electron 运行时里必抛 `External buffers are not allowed`，详见 docs/NOTES.md）。模型 163 MB（MeloTTS 为 MIT，但体积会推翻 93 MB 的安装包），所以不进安装包，首次选用离线引擎时才下载到 `data/tts-models/`。

坑：官方包里的 `model.int8.onnx` 只有 **133 字节**，是 Git LFS 指针不是模型，指过去会把推理子进程直接打崩（表现为探针静默无输出）。必须用 163 MB 的 `model.onnx`。

## 稳定的评测习惯

- 跑探针前先 `taskkill /F /IM electron.exe`：残留进程会抢单实例锁，导致探针静默退出、看到的是旧结果。
- 探针会读写真实的 `settings.json`（`%APPDATA%/oh-my-dota2` 与 `%APPDATA%/Electron` 两套），改配置时两边都要同步。
- 基准至少跑 3 次取中位数；模型侧延迟波动大，单次数字没有意义（总览卡的 p50/p90 才是给人看的指标）。
- 真实截图基准：`npm run bench:ocr -- --image .tmp/crop.png --scales 1,0.57`（截图可从「截图诊断」另存）。