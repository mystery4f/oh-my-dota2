## 正文源

### 抓屏 OCR 为什么被整条删掉
- 症状：屏幕识别在实机里长期不稳——OCR 单趟 0.3–3.7 秒、常驻流偶发回退到 desktopCapturer、区域被游戏 UI 遮挡就整屏读空。用户给出的结论是「OCR 方面的移除」。
- 根因：同一个信息（聊天正文）有两条来源，一条是猜（看屏幕），一条是收（Dota 自己推 GSI events）。猜的那条永远要面对分辨率、字体渲染、UI 缩放、遮挡、动画，成本却要付一份 runtime（onnxruntime 121 MB + 模型），安装包从 30 MB 涨到 198 MB。
- 修法：正文只留 GSI，删掉 PaddleOCR、onnxruntime、区域选择/高亮窗口、逐拍遥测与手动拍照；纯逻辑判据保留在 chat-lines / capturer 里，由 --chat-block-probe 冻结。
- 教训：当两条路都能给同一份数据时，先问「哪条是收、哪条是猜」。猜的那条即使指标好看，也会在真实环境里持续偿还环境差异的利息。

# 工程笔记（踩坑与结论）

本文记录「为什么会这样」和「以后怎么做」，按症状 → 根因 → 修法组织。结论性命令清单在仓库根
`AGENTS.md`，验收步骤在 `docs/ACCEPTANCE.md`，量化基线在 `docs/BENCH.md`。

## 环境与构建

### Electron 二进制没装上（报 `Error: Electron uninstall`）
- 症状：`npm run dev` 直接失败，`node_modules/electron/dist/` 为空且没有 `path.txt`，而 `npm install`
  退出码是 0。
- 根因：postinstall 的下载步骤在国内网络下静默失败，install.js 仍然返回 0。
- 修法：从 `https://npmmirror.com/mirrors/electron/v37.*/electron-v37.*-win32-x64.zip` 下载，用
  `C:\Windows\System32\tar.exe -xf` 解压到 `node_modules/electron/dist`，再写
  `printf "electron.exe" > node_modules/electron/path.txt`。Git Bash 自带的 tar 是 GNU tar，不能解 zip。
- 预防：`npm install` 时带 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 和
  `--registry=https://registry.npmmirror.com`。

### `--xxx-probe` 无输出、进程挂住
- 症状：`npx electron out/main/index.js --capture-selftest` 什么都不打印就退出，或卡到 120 秒。
- 根因：上一次的 electron 进程还活着，`requestSingleInstanceLock()` 失败后新进程直接 quit；另有一种情况是
  tsc 失败但命令用 `;` 串起来，于是跑了 `out/` 里的旧包。
- 修法：跑探针前 `taskkill //F //IM electron.exe`；用 `cmd /c "npx tsc ... && npx electron ..."` 而不是 `;`。

### PowerShell 脚本报「意外的标记 }」而那一行看起来没问题
- 根因：BOM-less 的 `.ps1` 被 PowerShell 5.1 按 ANSI/GBK 解码，中文字符的尾字节吞掉行尾换行，
  下一行代码并入注释，块结构就断了。
- 修法：所有部署到 userData 的脚本（`chat-inplace.ps1`、`chat-send.ps1`、`console-send.ps1`）保持纯 ASCII，
  注释也用英文；`ocr-bridge.ps1` 因为要写中文正则，部署时带 `\ufeff` BOM。
- 校验：`grep -cP "[^\x00-\x7F]" 文件` 应为 0；或用
  `[System.Management.Automation.Language.Parser]::ParseFile(...)` 解析一次。

## 抓屏

### 全屏独占下 OCR 一直读到同一帧
- 症状：日志每 30ms 一条 `wgc_capture_session.cc:237 ProcessFrame failed ... -2147467259`，画面在变但译文不变。
- 根因：WGC（Windows Graphics Capture）在 Dota 2 全屏独占模式下拿不到新帧，Electron 会复用旧帧而不是报错。
- 修法：`app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer')`，让 Chromium 回落到
  DXGI/GDI 桌面复制；同时把 `maxFrameRate` 从 30 降到 10，减少失败噪声。
- 判据：日志干净不等于修好，必须是「画面在变」。切手动模式连按两次 `Alt+Shift+C`，两次内容相同就是冻结帧。

### 抓一帧要 0.9 秒
- 实测：`desktopCapturer.getSources` 无论缩略图给 2560、480、192 还是 96 宽，都在 800–1800ms；
  瓶颈在捕获通道本身，不在缩图。
- 修法：常驻隐藏窗口跑 `getUserMedia({chromeMediaSource:'desktop'})` 拿视频流，主进程要帧时让渲染进程
  `canvas.drawImage` 裁切并回传 PNG：首帧 1.2s（含启动），之后每帧 12–21ms。
- 前提：Chromium 会节流后台/被遮挡窗口的视频流，必须加
  `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、
  `--disable-background-timer-throttling`，并对隐藏窗口调用 `setBackgroundThrottling(false)`。
- 兜底：视频流失败（例如显示器切换）冷却 30 秒后走回 `desktopCapturer`，`CaptureStatus.grabSource` 会标 `sources`。
- 握手坑：窗口 `loadFile` 之后立刻 `webContents.send(STREAM_INIT)` 会丢消息——渲染脚本还没挂监听。
  必须先由渲染进程发 `STREAM_HELLO`，主进程再回 `STREAM_INIT`。

### 坐标对不上（截到别的区域）
- `chatRegion` / `inputRegion` 存的是 DIP；`desktopCapturer` 缩略图与视频流帧都是物理像素。
- 换算：`(region.x - display.bounds.x) * display.scaleFactor`，尺寸同理。

### 移动镜头时 OCR 疯狂触发
- 根因：整屏亮度变化很大但聊天文字没变，用「整体灰度差异」做判据必然误触发。
- 修法：`src/main/services/capture/fingerprint.ts` 只统计**亮像素**（luma ≥ 150）在 64×36 网格里
  的变化比例，阈值 `PRINT_CHANGED_CELLS = 0.0015`；再叠加空转退避（连续无新消息时 OCR 间隔加 0.5s，上限 +3s）。
- 标定：真实区域里新增一行聊天只让 0.22% 的格子变化，所以阈值不能定高。

## OCR

### PaddleOCR 首次识别 5 秒、后续也要 1–2 秒
- 根因：onnxruntime 默认把线程开满，线程争抢反而更慢。
- 修法：`intraOpNumThreads = clamp(cpus/2, 4, 8)`、`interOpNumThreads = 1` → 0.8–1.2 秒。
  实测 12 线程以上明显退化（1.4–2.0 秒）。
- 注意：缩小图片（0.35 倍）能到 0.25 秒，但会读错（`rs in 30s` → `rs in 3es`），不要默认降分辨率。

### Windows OCR 把英文拆成单个字母、中文逐字带空格
- 根因：机器只装了 `zh-Hans-CN` 引擎，用它识别拉丁字母会碎片化；中文引擎按词切分会在字间插空格。
- 修法：默认引擎换成 PaddleOCR（PP-OCRv4 中英）；Windows 引擎保留为可选，桥里做多引擎合并（按 bbox 重叠
  >50% 归为同一行，按「脚本一致 + 置信度」打分择优）并在最终结果里剥掉内部分数。
- 中文空格：`cleanCjkSpacing()`（`src/main/services/capture/capturer.ts`）去掉 CJK 字符之间的空白。

### 多条聊天被并成一条
- 根因：真实聊天行的前缀比想象长——`[队友] Balance(Bot) [LISA.] ` 共 26 字符，旧正则上限 24，于是每条新
  消息都被当成上一条的续行。
- 修法：`SPEAKER_RE = /^([^:：\n]{1,48}?)\s*[:：]\s*(?=\S)/`，允许冒号前有空格；
  `startsNewMessage()` 供合并与解析共用；OCR 把两条并到一行时用 `splitInlineMessages()` 按第二个频道标记切开。

### 滚动时同一条消息重复翻译
- 修法分三层：`normalizeLine()`（去空白、标点、符号再小写）做完全重复过滤；
  `dropClippedLines()` 丢弃顶部被裁切的半行（顶边 <0.6 行高或高度 <0.75 行高中位数）；
  `isNearDuplicate()` 要求「前缀/后缀命中 **且** 编辑距离 ≤ max(2, 10% 长度)」——只靠前后缀会把
  `push top now A1` 和 `push top now B2` 误判成同一条。

## 翻译会话

### 「加个术语表」先看清原提示词已经写了什么
### 词库「读得到、写不进」——索引坏了
- 症状：面板上「词库 N 对 · 命中 M 次」不涨，浮层也不再有「词」标，看起来像词库丢了；日志里
  `TRANSLATE_CACHE_WRITE_FAILED database disk image is malformed`。
- 根因：sqlite 的索引损坏后 `SELECT` 仍能返回旧行，但每次 `INSERT` 都抛错。查库走 `idx_pair_b`，
  一抛异常就按「没命中」处理，于是每句都变成现翻——两个症状其实是同一个原因。
- 修法：打开库时跑一次 `PRAGMA quick_check(1)`，不是 `ok` 就把文件（连同 `-wal`/`-shm`）改名隔离再重建；
  写失败若是 `malformed/not a database`，隔离后重试一次，仍失败才降级到内存 Map。
- 教训：缓存层必须自带体检。它坏掉时永远不报错给用户，只表现为「功能悄悄不工作」。
- 手工修库要小心：WAL 模式下重建后务必 `wal_checkpoint(TRUNCATE)` 再关闭、把 `-wal`/`-shm` 一起处理，
  否则挪走的只是一个没写完的主文件。另外 `--xxx-probe` 用的是同一个 `data/` 目录，会往真账本里写
  `origin='probe'` 的测试行——这不是丢数据，但看起来很像。
- 症状：想提升黑话译法，于是新建 `glossary.ts` 装了一张 100 条的中英对照表，再挂到 `buildSystemPrompt` 后面。
- 根因：`SYSTEM_PROMPTS` 里已经有 `JARGON_KEEP`（明确要求 `gg`/`wp`/`ss`/`b` **保留不译**）和逐条译法（ward → 插眼、gank → gank/抓人）。新表把 `gg` 映射成「打得好」、`ss` 映射成「消失」，与既有规则直接打架，模型只会随机选一边。
- 修法：删掉独立模块，只把**原提示词没覆盖的**几条追加进既有那行 Style（hex → 变羊、root → 定身、silence → 沉默、slow → 减速、stun → 眩晕、initiate → 先手、courier → 信使、tango → 吃树、low → 残血、out of mana → 没蓝），反向补 hex/root/silence/slow/initiate/courier/tango/low/oom。
- 教训：提示词里加内容前先通读现有提示词。同一个概念有两个来源时，先算「冲突」再算「补充」——冲突的代价远大于补充的收益。

### 会话层偶尔「卡在翻译里」
- 根因：`conversation.submit()` 只是入队，`submission.wait()` 超时只是客户端放手，服务端那一轮生成还在跑；
  下一句 submit 排在其后，用户看到的就是长时间无响应。sqlite 里能看到 `submissions.status=placed` 无 answer、
  `tasks.status=running`、assistant 条目 `durationMs` 极大。
- 修法：`translateWithSession()` 在超时路径调用 `conversation.abort(session.context)`；直连对冲先返回时也中止在跑的
  会话回合。回复路径预算收紧为 `REPLY_BUDGETS = { warm: 9_000, cold: 15_000 }`，对冲阈值 1.8 秒。

### 译文把原文原样吐回（回声）
- 根因：会话历史被「原文原样返回」的行污染，形成 few-shot 自我强化；删库立刻恢复，说明是历史问题而非提示词。
- 修法：`isEcho(source, output)`（去空白/标点/符号后小写比较），命中先 `resetHistory()` 重译一次，仍回声就抛错走直连兜底。

### 回复翻译输出「The user said ...」这类解释
- 根因：zh-en 会话把「解释用户输入」当成任务完成。
- 修法：`looksLikeCommentary()`（`src/main/services/providers/index.ts`）命中则重置会话重译一次，仍命中抛错；
  `buildSayTeamCommand()` 再兜一层——没有可打印 ASCII 字符就返回错误而不是发 `say_team ""`。

### 会话互相污染
- 槽位 = `方向#语气` 再叠加 scope（`prod` / `try` / `warm`）。探针与「翻译试用」绝不能用 `prod` 槽，
  否则测试数据会把真实翻译带偏。
- 库文件按 provider 哈希隔离（`translator-<sha1(provider)前8>.sqlite`），换 provider 或跑假 provider 探针不会写脏真实历史。

### 推理模型把 token 全花在思考上
- 症状：`finish_reason = length` 而 `content` 为空；或「测试连接」一直失败。
- 修法：`compat: { thinkingFormat: 'zai' }` + `thinkingLevel: 'off'` 让 pi-ai 下发 `thinking:{type:'disabled'}`；
  非流式路径显式带 `reasoning_effort: 'none'`。测试连接的 `maxTokens` 提到 256。
- 另外：开思考时服务端会强制 `temperature = 1.0`，要确定性输出就必须关思考。

## 回复直发

### 源 2 引擎的两条通道结论不能互套
- **控制台**：不认任何粘贴（`Ctrl+V`、整串 SendKeys 都只在 console.log 留一行 `Unknown command: [`）；
  只能逐字符产生真实按键事件。交互上被判「很不流畅」。
- **Panorama 聊天框**：接受注入的 `Ctrl+A` / `Ctrl+C` / `Ctrl+V`；原地替换并回车是当前默认通道。

### 注入方式
- 有效：逐字符 `SendInput`（VK 码，或 `MapVirtualKey` 转 SCANCODE）。
- 无效：`KEYEVENTF_UNICODE`（SDL 直接丢弃）。
- 组合键时序：按住 20ms、间隔 25ms（一次组合 85ms）稳定；`Panorama` 约 16ms 一帧，更快的版本会偶发丢键。
  首轮取不到内容时用 45/70ms 慢速重试一次，日志记 `retried`。

### 写剪贴板卡十几秒
- 根因：`[System.Windows.Forms.Clipboard]::SetText` 在剪贴板被其他进程占用时会长时间重试。
- 修法：ps1 里改用 C# P/Invoke（`OpenClipboard` 20×15ms 重试 / `EmptyClipboard` / `GlobalAlloc` /
  `SetClipboardData`），写入耗时实测 0ms。

### 「游戏输入桥已退出」且再也起不来
- 根因：`dispose()` 后立刻重连时，旧子进程的 `close` 事件在新进程已赋值之后才到，把 `this.child` 清空。
- 修法：`child.on('close'|'error')` 开头 `if (this.child !== child) return`。

### 抢不到前台
- Windows 只允许「刚刚接收过输入的线程」或持有前台权的进程调用 `SetForegroundWindow`。
- 可行做法：轻敲一次裸 `Alt`（VK_MENU down/up）→ `BringWindowToTop` → `SetForegroundWindow` → 等 ~320ms →
  校验 `GetForegroundWindow()` 是否等于目标窗口，不等就重试一次；仍失败返回 `NOFOCUS` 并回传 `fg`/`win` 句柄便于排查。

## 语音

### whisper 模型下载只有 43KB/s
- 根因：hf-mirror 对单连接限速。
- 修法：先 `Range: bytes=0-0` 取总长度，再 16 路并发 Range 下载分片、顺序拼接（实测 3.7MB/s，141MB 约 40 秒）。

### 系统嗓子念中文像播报，换 Edge 神经语音
- 症状：朗读能出声，但中文只有一个「慧慧」（Windows 自带的拼接音），念游戏聊天像地铁报站。
- 根因：`speechSynthesis` 的音色由系统安装的语音包决定，Windows 中文就那一个；想换嗓子只能换引擎。
- 修法：主进程用 `@andresaya/edge-tts`（微软免费的朗读接口，无需账号）合成 mp3，base64 下发给浮层用 `Audio` 播；合成失败/超时 4 秒就**退回系统嗓子**，绝不静音。设置里 `ttsEngine: 'edge' | 'system'` + `ttsVoice` 选嗓子，面板给「晓晓·温暖 / 晓伊·沉稳 / 小北·东北话」。
- 踩坑：`msedge-tts` 这个库连上去回 401/200（协议改了，需要 `Sec-MS-GEC` 且旧 token 失效），同一个地址 `@andresaya/edge-tts` 能通，实测 19 KB mp3。**判断「接口还活着」要拿真实合成结果，不要拿 HTTP 状态码。**
- 两个嗓子是两条路：`system` 全离线（断网可用）；`edge` 联网但好听。都保留了。

### 朗读「只念别人说的」这条不能加
- 症状：想让朗读跳过自己发的消息，于是给 `decideSpeak` 加了 `if (entry.own) return null`。
- 根因：`own` 来自 `slotIsSelf(player_id, player_slot)`，而**英雄试炼场/训练场里所有 player_id 与自己的 slot 都是 0**，于是每条消息都被判成「我说的」——朗读彻底静音，看起来像功能坏了。
- 修法：撤回这条过滤。`own` 字段仍留在 `CaptureEntry` 上（对账、统计要用），但不再挡朗读。
- 教训：不要在「身份判定」之上叠用户可见的行为开关。身份判错的代价能从「多一点噪音」放大成「功能完全不可用」。

### 朗读没声音：先分清合成失败还是播放被拒
- 症状：换 Edge 神经语音后一点声音都没有，日志里也没有报错。
- 根因：Chromium 的 autoplay 策略默认要求先有用户手势，主进程下发的 `new Audio(...).play()` 直接被拒；`play()` 的 rejection 被 `.catch(done)` 吞掉，于是「什么都没发生」。
- 修法：启动时 `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`；播放失败必须 `console.log('VOICE_PLAY_FAILED', ...)` 并退回系统嗓子。探针 `--tts-play-probe` 把浮层控制台日志抓回主进程，一次分清「合成失败（bytes 0）」和「播放被拒（VOICE_PLAY_FAILED）」。
- 教训：「没有声音」是二值的观测，但原因至少三种（没合成、没播、播了没音量）。先把观测拆成三段，再谈修。
- 症状：开启朗读后，自己在游戏里打完一句，浮层立刻用语音把这句话（或它的译文）念一遍，盖住队友下一句。
- 根因：GSI 的 `own` 标记只用来做统计（`record.own`），没进 `CaptureEntry`；`decideSpeak` 只看「有没有译文」，于是自己那行也进了朗读队列。
- 修法：`recordChatEvents` 返回 `{ text, own }`，`pushMessages` 把 `own` 带到条目上，`decideSpeak` 第一道判断就是 `if (entry.own) return null`。上屏行为不变——用户要的是「只看一个地方」，自己的话仍要看得见。
- 教训：「要不要显示」和「要不要朗读」是两套判据，别让一个布尔同时承担两件事；凡是决定输出方式（声音/通知）的地方，都要先问「这是谁产生的」。

### 静音时 whisper 输出 `[BLANK_AUDIO]` 幻觉
- 修法：录音段先算全段 RMS，低于 0.012 直接提示「没有检测到语音」；转写结果再过滤 `[BLANK_AUDIO]` 等标记。

### edge-tts 连不上
- 根因：直连 Edge 语音服务在国内超时（`connection timed out after 10000ms`）。
- 修法：`msedge-tts` 构造时传 `{ agent: new HttpsProxyAgent(proxyUrl) }`，并在用完后 `tts.close()`，否则 ws 不退出。

### 调音高之后一句都不念了（pitch 单位是 Hz，不是百分比）
- 症状：给朗读加「音高」滑杆，`--tts-bench` 从 10/10 掉到 0/10，每句 `ms≈0、bytes=0`，日志里连网络错误都没有。
- 根因：`@andresaya/edge-tts` 的 `validatePitch` 只认 `'-100Hz'..'+100Hz'` 或纯数字，我按语速的习惯传了 `'+10%'`，它在建立连接之前就抛 `Invalid pitch format`，被 `synthesizeEdge` 的 catch 吞成一行 `EDGE_TTS_FAILED`。
- 修法：`pitchSpec()` 改成产出 Hz（倍率 −1 后 ×150，1.3 → `+45Hz`），并把「同句同嗓、0.75 与 1.25 两个音高合成出来的字节数必须不同」写成 `--tts-bench` 的 `pitchOk` 断言——只断两者不同，不断具体长度，否则改一句台词就红。
- 教训：`ms≈0` 的失败是「本地校验拒绝」，不是网络问题；先看有没有 `EDGE_TTS_FAILED`，再看参数格式。

### 离线朗读只能在真正的 node.exe 里跑（Electron 里必炸）
- 症状：集成 `sherpa-onnx-node`（Matcha 中文模型）后，纯 Node 跑得很好（p50 111 ms），一进 Electron 主进程就 `External buffers are not allowed`，每句都失败；换 `sherpa-onnx-node@1.13.8`、加 `ELECTRON_RUN_AS_NODE=1` 拉子进程，全部一样。
- 根因：`napi_create_external_arraybuffer` 在 Electron 的 Node 里被禁（外部缓冲无法被它的内存追踪覆盖）。这不是版本问题，也不是「主进程 vs 渲染进程」问题，换哪个 Electron 运行时都一样。
- 修法：合成交给**系统的 node.exe** 子进程——`resources/tts-offline-worker.cjs` 常驻、只加载一次引擎，主进程按行发 `{id,text,speed,dir,out}`、收 `{ok}`，WAV 落临时文件再读回。`offlineNodeBinary()` 用 `spawnSync('node',['-v'])` 探一次；找不到就把面板里的「本地模型」置灰并注明「需要本机 node」，不假装能用。
- 教训：装原生模块前先确认它在 Electron 里能跑，别只在 `node` 里验证。`electron-builder.yml` 里还要给 worker 配 `extraResources`，否则打包后路径在 asar 里，子进程读不到。

### 模块初始化里别调自己的函数（TDZ 会崩主进程）
- 症状：装好离线引擎后应用启动即崩：`ReferenceError: Cannot access 'nodeChecked' before initialization at offlineNodeBinary`。
- 根因：`let state: OfflineStatus = { available: offlineNodeBinary() !== null, ... }` 在模块顶层求值，而 `offlineNodeBinary` 闭包的 `nodeChecked`/`nodePath` 是同一个模块里更靠后的 `let`——函数声明会提升，它捕获的变量不会。
- 修法：模块级状态只写常量初值（`available: false`），真实值在 `offlineStatus()` 里现算。
- 教训：顶层初始化只允许「无依赖的常量」；任何会读模块内其他 `let`/`const` 的调用都要推迟到函数里。

## 发版与更新

### 装好的应用查不到更新（latest.yml 没上传）
- 症状：`release.yml` 绿了、Release 页面上有安装包，但客户端点「检查更新」永远回「已是最新」。
- 根因：electron-updater 不读安装包，它读**同一个 Release 里的 `latest.yml`**（里面有版本、sha512、文件名）。
  我最初只上传了 `*.exe` 和 `*.zip`，等于把更新器要读的清单丢了。
- 修法：打包命令旁边必须有 `publish` 配置（`electron-builder.yml`），上传时带上 `dist/*.yml`、`dist/*.blockmap`。

### Nightly 越堆越多，仓库存储爆掉
- 症状：每次 push main 都出一个 `Nightly HHMMSS`，一个 ≈ 460 MB（安装包 198 MB + zip 259 MB）。
- 根因：清理步骤写的是「保留最新 5 个」——在有 5 个之前它一个都不删，看起来像没生效。
- 修法：改成只留最新一个（`.[1:]`），旧的连标签一起删（`gh release delete --cleanup-tag`）。

### 自动更新不能跟预发布
- `autoUpdater.allowPrerelease` 必须为 `false`：否则某天夜里用户会被静默升级到一个半成品上。
  Nightly 是给人**手动**下载的，两条通道各自独立。
### Nightly 装好后点检查更新报「No published versions on GitHub」
- 症状：Nightly 包能装能跑，面板点「检查更新」立刻红字 `No published versions on GitHub`，`logs/updater.log` 里同一条。
- 根因：`electron-updater` 的 GitHub provider 不查 API，它抓 `https://github.com/<owner>/<repo>/releases.atom`，
  逐条 `semver.valid(tag)` 过滤，全被过滤掉就抛这个错。我们的 Nightly 标签是 `nightly-20261024-194835`，
  不是合法 semver（`nightly-…` 解析不了），于是预发布一条都进不来；正式版 `v1.0.0` 又因为
  `allowPrerelease=true` + `channel='nightly'` 的通道匹配规则被跳过。
- 修法：Nightly 标签改成 `v<package.json version>`，即 `v1.0.0-nightly.20261024-194835`。这样
  `semver.prerelease()[0] === 'nightly'`，既通过 `semver.valid`，又自动对上 `nightly.yml` 这个通道文件名。
  验证方式：`curl -s https://github.com/<owner>/<repo>/releases.atom | grep -o 'releases/tag/[^"]*'` 看到形如 `v1.0.0-nightly.…` 的标签即成立。


## 聊天数据源

### 控制台日志里没有聊天正文（想用日志替代 OCR 的路线已关闭）
- 症状：`PLAN.md` 候选方案说「`-log -condebug` 后聊天气泡会落成 `[Chat] [All|Team] 昵称: 内容`」，据此想用日志当数据源或改成事件触发捕获。
- 根因：实测不成立。`-condebug` 本来就开着，`D:\SteamLibrary\steamapps\common\dota 2 beta\game\dota\` 下有 `console.log` 加 10 个 `console.<matchid>.log`（真对局两个各约 25MB）。逐文件统计 `[Chat]` / `[All]` / `[Team]` / `say_team` / `PR:NotePlayerCommsTime` 命中数**全是 0**；聊天只留下 `[GCClient] Send msg 7273 (k_EMsgGCChatMessage), 40 bytes` 这种**只有事件和字节数、没有正文**的行，而且只有 `Send` 没有 `Recv`——队友发的消息连这样一行都不产生。`chatwheel` 只留 `CLocalize::FindSafe failed to localize: '#dota_chatwheel_message_*'` 这类本地化失败行。
- 结论：日志既当不了数据源，也当不了可靠的触发信号 → 捕获继续走屏幕 OCR。另外注意：每开一局日志会被「撕开」成新文件（`[EngineServiceManager] Tearing off console log, will continue using suffix '.<match_id>'`），所以想 tail 匹配尾部必须跟随租约文件而不是 `console.log` 本身。

## 自动捕获

### 「自动轮询在实机不稳定」是一句没有证据的话
- 症状：`captureMode` 默认被改成 `manual`，理由是「自动轮询在实机不稳定」，但日志里什么都没有——自动模式原来只在出错时写一行，正常跑和「根本没在跑」在外部完全分不出来。
- 根因：捕获循环没有热路径遥测。`status()` 只有累计计数（`ocrRuns`、`emptyTicks`），看不出「第 37 拍抓了 900ms、判成 `sources`、OCR 又花 4 秒」。所以任何「不稳定」都只能靠猜。
- 修法：`src/main/services/capture/telemetry.ts` 在 `tick()` 的 `finally` 里落一行 JSONL（`logs/capture-ticks.jsonl`，单文件 ≤1 MB，超限直接清空重写，磁盘占用恒定）。字段刻意选成能直接分辨失败模式的：`act`（`ocr|same|gap|idle|error|busy`）、`src`（`stream|sources`）、`chg`（变化比例）、`need`（这一拍所需的阈值）、`grabMs`/`ocrMs`、`lines/msgs/fresh/dup/own`（新行还是全旧）、`streak`（空转了几拍）。探针 `--capture-telemetry-probe [秒数]` 跑自动模式并断言「每拍都有 `grabMs`、没有 `error`、文件 <1 MB」。
- 读法：`src=sources` 连续出现＝常驻流掉了（全屏独占的老问题）；`act=gap` 密集＝退避把消息让过去了；`act=ocr` 但 `chg` 高、`fresh=0`＝区域里有动的东西在骗指纹；`at` 的相邻差值远大于 `intervalMs`＝那一拍卡在 OCR 或抓屏里。
- 别忘了：`start()` 的 `mode` 可以被探针覆盖（`start(region, { mode: 'auto' })`），否则会跟着设置里的 `manual` 跑，白跑一趟。

### OCR 单次 1-2 秒是自动模式的天花板，缩图和换入参都省不掉
- 症状：轮询间隔设 800 ms，实测节奏也真的是 809 ms，但只要有新消息的那一拍，间隔就会被拉到 2-5 秒。
- 根因：OCR 本身。`@gutenye/ocr-node` 跑 1600x406（聊天区 DIP 1066x271 × scaleFactor 1.5）单次 315 ms–3680 ms，暖机后常见 2.0-2.3 s，与抓屏（70 ms）差一个量级。所以自动模式的真实上限是「每 1.5-2.5 s 读一屏」，把间隔改成 500 ms 只会让 `gap`/`busy` 变多。
- 顺带否掉的两个想当然优化：① 生产路径是「写 PNG 文件 + `detect(path)`」，换成「raw buffer + `detect({data,width,height})`」实测 1129 → 1184 ms，没有差别（库内部一样要过 sharp）；② 缩到 1072 宽省 18%（920 ms）但 `gg wp` 变成 `ggwp`、`[LISA.]:` 的空格丢失，800 宽更糟，不划算。
- 后来被真对局数据推翻了一半：对局里 OCR p50 只有 216 ms、抓屏 185 ms，那段「2.0-2.3 s」只出现在捕获区塞满中文的桌面场景。所以上限不在 OCR 本身，而在「捕获区里有多少字要认」。别把这个数字当通用结论引用。

### 手动能覆盖、自动不能覆盖：两种模式的显示语义必须分开
- 症状：手动「拍一张」是整屏重建，覆盖式天然合理；自动模式要是也跟着覆盖，屏幕上只有 8-9 行，翻页前的聊天就没了。但自动纯追加又会把上一局的聊天一直挂在浮层上，新局第一句还会被当成重复丢掉。
- 根因：两种模式的真相来源不同。手动是「此刻屏幕内容的一份快照」，自动是「这一局累积下来的历史」。历史需要一个终止条件，而程序不读内存、不读对局状态，只能从 OCR 看得见的东西推。
- 修法：`src/main/services/capture/session.ts` 判「换了一局」——屏幕上 ≥3 行、且和去重窗口里的记录**完全不重叠**、且历史已有 ≥10 条，连续 3 拍如此才认定换局。新消息总伴随旧行（重叠 ≥1），所以单这一条就能把「来消息」和「换局」分开。认定后清空去重窗口（`recent`/`recentSet`）并广播一次空的 `CAPTURE_REPLACE` 把浮层和面板清掉，紧接着那一拍的整屏内容因为窗口刚清过会全部作为新行重新上屏——顺序是「先清、再追加」，避免清完之后这一屏反而没被推上去。探针 `--session-break-probe` 覆盖 8 个单拍用例 + 连续触发 + 中途打断归零。
- 上限与漏读：浮层留最近 40 行（`src/renderer/overlay.ts` 的 `MAX_ROWS`）、面板 50 条，满了挤掉最早的。OCR 单次要 1-2 秒，这期间滚过去的行**不补**——把「屏幕可见行」当真值会让迟到消息插到中间，代价比少翻译一句大。

### 浮层默认只显示译文，但「等翻译」不能是空白
- 症状：默认把原文和译文上下叠着显示，字多、块高，浮层在游戏里挡视线；改成只显示译文后立刻踩到第二个坑——译文要 1-2 秒才回来，这段时间那一行就空着。
- 根因：显示层次和翻译时序是两件事，混在一起做就会二选一：要么早显示原文（信息全但无用），要么晚显示译文（干净但断档）。
- 修法：`overlayText: 'translated' | 'both' | 'original'`（默认 `translated`）只管**译文到达之后**显示哪一层，靠 CSS 的 `body[data-text]` + `.row:has(.trans)` 切换；译文到达之前那一拍永远先上屏原文并标 `pending`（压暗 + 「翻译中…」），到达后 `CAPTURE_UPDATE` 就地替换同一行的 `.trans`。所以任何时刻都没有空行，规则也只有一句：**先上屏，再替换**。探针 `--overlay-probe` 把四种视图都断言了一遍。

### 游戏画面里「指纹没变」这个前提是不成立的
- 症状：桌面上静止画面 34/40 拍被指纹判掉，进游戏后同样的代码 `same` 一次都没有 —— 每一拍都判「变了」，全部进 OCR。
- 根因：捕获区是半透明聊天面板，背后是整块会动的游戏世界。菜单、技能面板、镜头平移都会让亮点评分从 0.1 飙到 0.99，自适应阈值抬到 0.0045 也拦不住。指纹设计时假设「没新消息≈画面不动」，这在 HUD 上不成立。
- 修法（现在是绕开而非修好）：真正节流的是 `ocrGap` 退避——`noNewStreak` 每涨一次就把下一次 OCR 的最早时间往后推 500 ms（上限 3 s），所以 72 s 里只 OCR 了 19 次，节奏仍然稳在 801 ms。要根治得把判据从「整块区域变化」改成「只数文字行的行高带」，或者直接接受「有消息的时段 OCR 勤、没消息的时段靠退避慢下来」。
- 顺带纠正一个旧假设：进游戏后 OCR 反而更快（p50 268 ms，桌面 2207 ms），因为捕获区小、场上中文少；**变慢的是抓屏**（202 ms vs 72 ms），游戏在前台时 `getUserMedia` 抽帧要和 GPU 抢时间片。


### 两条定时器链同时在跑，`busy` 占掉两成的拍
- 症状：真对局 383 拍里 `busy` 75 次（约 20%），节奏仍然是 801 ms，看起来「没问题」；但把遥测按 `at` 排序会看到成对的记录**时间戳完全相同**（`38.459 busy` / `38.458 gap`），节奏 p50 算出来是 0。
- 根因：`tick()` 的 `busy` 分支自己调了一次 `this.scheduleNext()`，而 `finally` 里无条件又调一次。`return` 不会跳过 `finally`，于是每撞一次 busy 就多出一条定时器链，两条链此后一直交错跑：一条抢到 `inFlight` 干活，另一条撞上 `inFlight` 记 `busy` 并再分叉。`busy` 因此不是「上一拍没跑完」的性能信号，而是自己复制自己的 bug 证据。
- 修法：`scheduleNext()` 开头 `if (this.timer !== null) clearTimeout(this.timer)`（任何路径重复排程都只会留下一条链），并删掉 `busy` 分支里的那次调用，把排程统一交给 `finally`。重启复测（同样 20 s 窗口）：`busy` 从 30/60 归零，`cadence p50` 从 0（成对撞毫秒）回到 801、p90 802。
- 教训：只要一个「跳过」分支里手动调了排程函数，就一定会和 `finally` 的兜底排程打架。排程函数本身必须是幂等的，不能依赖调用方自觉。
### 不在对局、不在前台时还在烧 OCR
- 症状：自动模式一旦开始就永不停：退出对局、切到浏览器、最小化游戏，照样每 800 ms 抓一次屏、认一次字，`lines` 一直是 0（或者认的是浏览器里的中文）。
- 根因：两处都只看「有没有开」，不看「该不该开」。`start()` 之后只有用户点停止才会停，而 GSI 的 `stop` 分支还额外要求 `runtime.startedByGsi` —— 手动开的捕获，一局结束也不会停。前台与否则完全没人问：`grabCrop` 抓到什么就 OCR 什么。
- 修法：`capturer.ts` 的 `tick()` 在抓屏前加一道闸门 `gameFocused()`，问常驻输入桥（`chat-inplace.ps1` 新增 `focus` op，`Get-Process dota2` + `GetForegroundWindow` 比对）游戏是否占着前台；不在前台就只记一条 `act:"idle"`，抓屏和 OCR 全省。结果缓存 `FOCUS_TTL_MS=900`，查询失败一律放行并冷却 `FOCUS_RETRY_MS=30s` —— 闸门坏了不能反过来把捕获关死。GSI 那边把停捕获的 `startedByGsi` 前置条件去掉，改由 `shouldStopCaptureOnMatchEnd(mode)` 决定：自动模式随对局结束就停（下一局 GSI 会再拉起来），手动模式不动（那里的开关是用户的，替他关只会让热键静默失效）。看门狗（90 s 无推送）走同一条规则。
- 判据：`--gsi-probe` 里加了 `shouldStopCaptureOnMatchEnd('auto') && !shouldStopCaptureOnMatchEnd('manual')`，纯函数可断言，不必真的开关捕获。真正跑一局要看的数字是遥测里 `act:"idle"` 的占比——它应该和「不在游戏里」的时间成正比。

## 对局状态（GSI）

叫法统一如下，后面聊天、日志、代码都用这一套，避免同一个东西三种说法：

- **GSI**：整条链路的正式名，Game State Integration，中文「游戏状态集成」。代码里就是 `gsi.ts` / `--gsi-probe` / `--gsi-dump`。
- **GSI 帧**：Dota 推过来的**一次** JSON POST。日志里说「这一帧」就是它。
- **GSI 端口**：`127.0.0.1:32123` 这个本地监听口，由我们的 cfg 指向。
- **推送**，不是「回调」：我们是 HTTP server，Dota 是 client，主动方在游戏那一侧。说「回调」会让人以为我们先发请求再等回应。
- 心跳：Dota 在没变化时每 30 s 打一帧（cfg 里的 `heartbeat`），我们 90 s 收不到任何帧就当对局已结束（看门狗）。

### 捕获循环判断不了「在不在对局里」——GSI 补上这一半
- 症状：想把默认模式切回自动，但自动模式没法自己知道对局开始/结束：聊天区没人说话和不在游戏里，在 OCR 眼里是同一张图（都是静止的空聊天框）。用户只能手动开关，忘了开就是「一局都没翻译」。
- 根因：屏幕是唯一输入，缺少对局状态这个独立信号源。Dota 官方的 Game State Integration 正是干这个的：Dota 主动把 JSON POST 到本地 HTTP 端口，不需要注入、不读内存。
- 修法：`src/main/services/gsi.ts` 在 `127.0.0.1:32123` 起监听，`src/main/services/gsi-config.ts` 自动写 cfg。判定只认翻转（`PRE_GAME`/`GAME_IN_PROGRESS` 开一次，`POST_GAME`/`DISCONNECT` 停一次），所以用户中途手动停掉捕获不会被下一拍心跳又拉起来；`autoStartCapture` 关掉时 GSI 也不替他开。

### GSI 的 cfg 每个工具一份，且只在游戏启动时读
- 症状：写完 cfg 但收不到推送；或者担心和罗技 G HUB 的配置互相覆盖。
- 根因：Dota 读 `cfg/gamestate_integration/` 目录下**所有** `*.cfg`，每个文件各自带 `uri`，所以多工具天然共存（本机 `gamestate_integration_logitech.cfg` 走 3002）。但读目录只发生在游戏启动时，运行中改文件不生效。
- 修法：文件名带工具前缀（`gamestate_integration_ohmydota2.cfg`），端口错开（32123 vs 3002），改完必须重启一次 Dota。`data` 里只开 `provider`/`map`/`player`——`abilities`/`items` 对聊天工具没用，只会把推送频率推高。

### 不带 `map` 的帧不该清掉上次的对局状态
- 症状：状态栏偶尔闪成空，排查时以为推送断了。
- 根因（探针抓到）：`handleGsiPayload` 早先把 `gameState` 无条件写成这一帧的值，遇到坏包或不含 `map` 的帧就是 `null`，把上一次读到的 `POST_GAME` 抹掉了。
- 修法：只有这一帧真的带 `game_state` 才覆盖 `gameState`/`matchId`；`live` 判定照常每帧算。`--gsi-probe` 里专门推了一个「不是对象的 JSON」来锁这条。

### 聊天正文也能从 GSI 拿，只是要显式开 events
- 症状：一直以为「GSI 没有聊天正文」，所以正文只能靠 OCR。这个结论其实是残缺配置的回声：我们的 cfg 只开了 `provider`/`map`/`player`，自然一条聊天都收不到。
- 事实：`data` 段加 `"events" "1"` 之后，对局内聊天作为 `chat_message` 事件进 `payload.events[]`，形如 `{game_time, event_type:"chat_message", player_id, channel_type, message}`；`channel_type` 11 = 所有人，12 = 队伍（13 观战、14 教练）。同机的 Logitech 不读 events，所以多开这一块不会和它抢数据。
- 现状（2026-11 已对账）：`chatSource: 'ocr' | 'gsi'` 是两条**并列**的自动路线，面板上「正文：屏幕识别（OCR）／正文：游戏推送（GSI）」二选一。GSI 路不抓屏、不跑 OCR、也不要聊天区域，正文由 `pushMessages()` 直接进渲染层与翻译队列；自己的发言照常显示（用户要求：只看一个地方就够）。`logs/gsi-chat.jsonl` 仍是原始证据（每条 `chat_message` 一行，`own` 用 `player.player_slot` 标出）。
- 必须去重：Dota 会把同一条聊天连续推 **26–27 帧**（实测 157 行只对应 6 句）。键用「`game_time` + `player_id` + `channel_type` + 槽位 + 正文」，只在第一次出现时落盘/上屏——同一句话在不同时间说是合法的两行，所以不能用「正文相同」去重。
- 昵称要另外开 `"allplayers" "1"`：`chat_message` 里只有 `player_id`（slot），没有名字。cfg 开了 allplayers 之后 `payload.allplayers` 是一张 slot → `{name, team, hero}` 的表，用它把 slot 翻成昵称，翻不出来时退回「我 / 玩家N」，绝不因为缺名字丢消息。一局结束（`POST_GAME`/`DISC`）清掉这几张缓存——下一局同号位换人。
- 上屏行格式（2026-11 定）：`[英雄] [关系] [昵称] 频道符号 正文`，例 `[lina] [队友] [队友A] ⚔ 别送我`。三块各管一件事——英雄认人（昵称常常是拼音或大写英文，英雄一眼就认出是谁），关系看站哪边（`我`/`队友`/`敌方`，阵营没拿到时老实写 `玩家`），符号看谁能看见（`⚔` 只有队友，`🌐` 双方）。自己那份 allplayers 里没有，要单独开 `"hero" "1"`；缺哪块就省掉哪块，不填空壳。
- 只要正文含汉字就不翻译：两条路都先看正文，出现任意一个汉字（`hasHan()`）就认定已经是目标语言，跳过模型直接以「无译文」上屏——只译文模式下没有 `.trans` 层的行会回落到原文，正好就是要显示的样子。中英混排也算（`push 中路 now` 不翻），因为翻过去只会把「中路」再糟蹋一遍。判的是**正文**不是整行：GSI 那行的 `[队友]`/`[敌方]` 自带汉字，拿整行判会把 `lol`、`back off` 这种纯英文误判成中文，所以 `chatBody()` 先剥掉 `[...]` 前缀和频道符号。早期版本用的是「汉字占比 ≥50%」，用户明确要求改成「包含即跳过」。`--chat-block-probe` 固定了七个用例。
- 一次实测（`--gsi-dump 40`，英雄试炼场）：`map.customgamename` 指着 `dota_addons/hero_demo`、`map.matchid` = `0`，此时 `allplayers` 整块缺席、`events` 是空数组——试炼场不是对局，别拿它验数据块。
- 教训：为了「省流量」只开 `map`/`player` 最小集合，最后是要付两次账的——先是聊天正文收不到（以为 GSI 不支持），再是收到正文但没有名字。数据块别抠。
- 一项对账数字（同一 20 秒、玩家连发 7 句）：GSI 7 条唯一且逐字准确（「什么？」的全角问号都在），推送即到；OCR 19 拍产生 19 条 `fresh`（7 句被读成 19 条，约 2.7 倍膨胀，`dup` 只拦下 2 条），`ocrMs` 171–536 ms、落后 1–3 s。
- 脏字是 Dota 层遮蔽的：有一句到达就是 `你是****`；OCR 看屏幕同样是星号，所以两条路口径一致，不是 GSI 的缺陷。
- 还没验证：敌人频道 `channel_type` 11（所有人）在真实对局里一次都没出现过，目前样本全是 12（队伍）/`own:true`。
- 教训：把自己的配置当成工具的能力边界，是这类「官方不支持」结论最常见的来源。下结论前先确认「是不是没开数据块」。

### 正文源选了 GSI，面板还在手动模式——推送全被静默吞掉

- 症状：`logs/gsi-chat.jsonl` 一路在涨（说明帧到了、正文也解析出来了），但浮层不出新行，记账本里也一句都没多。用户以为「英文没翻译」，其实是消息根本没进翻译队列。
- 根因：`gsi.ts` 的 `pushChat` 里多了一道 `capture.status().mode !== 'auto'` 的闸。那道闸本意是保护「手动模式等于拍一张照」的语义，可 GSI 正文压根没有快照这回事——用户一手动切正文源，推送就全部被 `return` 掉了，而且没有任何日志。
- 修法：`pushChat` 只看 `chatSource`，不再看模式；手动模式说的是抓屏语义，与推送无关。判定这类「静默丢消息」最省事的办法就是往端口推一帧合成 payload，然后看记账本有没有多一行——比读代码快。

### 阵容缓存只在「局末」清一次就会串局
- 症状：面板上的阵容在下一局开始时还挂着上一局的英雄；同一个人从 `allplayers` 和 `player` 两条路进来还会各占一行。
- 根因：局末只清了 `slotNames`，`slotHeroes` / `slotTeams` 留在内存里；槽位还有两套写法——`allplayers` 的 key 是 `"0"–"9"`，而 `player.player_slot` 里夜魇带 128 偏移（`128–132`），按 `% 128` 归一会让 128 和 0 撞在一起。
- 修法：局末三张缓存连同自己那份槽位/阵营一起清；`normalizeSlot()` 把 `128–132` 折成 `5–9`（而不是 `0–4`），这样两条路进来的同一个人能合并成一行。`--gsi-probe` 用 `rosterOk` 把「局末清空」和「我方在前、英雄名去掉 `npc_dota_hero_` 前缀」都钉住。
- 教训：缓存清理要按「一起进来的就是一起走的」成组处理；跨两套编号体系的槽位，归一化目标必须选**两边都能表达**的那一套。

### 想看清 Dota 推了什么，探针和真对局是互斥的
- 症状：`--gsi-dump` 能把每个字段路径摊开，但它要独占 32123 端口；而想看真对局的数据，应用必须开着。于是「仪器」和「被测对象」抢同一个端口，一局打完什么也没留下。
- 根因：把观测做成了独立进程。GSI 是单端口推送，谁先监听谁拿到数据，第二个只能报 `EADDRINUSE`。
- 修法：把记账搬进应用本身。`src/main/services/gsi-frames-summary.ts` 在内存里按 cfg 块和 `event_type` 归类（纯逻辑在 `gsi-dump-analysis.ts`，可离线复算），每 5 秒原子落盘 `logs/gsi-summary.json`，`map.matchid` 变了就清账（避免上一局的统计污染这一局），`POST_GAME` 时立刻终落。判读用只读探针 `--gsi-dump-report [文件]`，它只看文件，dev 应用开着也能跑。
- 结论一句话就够：`真对局（matchid …）· allplayers 有数据（4210/4812 帧）· 事件类型 chat_message×146、player_connected×10`。训练场/人机/主菜单的 `matchid` 是 `0`，一眼能分开，不必再猜「为什么 allplayers 没来」。
- 注意：探针直接跑 `out/main` 时 userData 是 `Electron`，dev 应用是 `oh-my-dota2`，所以判读会同时看两个目录并取最新的那份。
### 闸门永远判「不在前台」——客户端把答案字段吃了
- 症状：真对局里自动模式连续 12 分钟全是 `act: idle`，一拍 OCR 都没跑；同时 `logs/gsi-chat.jsonl` 里已经有玩家自己发的聊天——人明明在游戏里，闸门却说不在前台。
- 排查：桥本身是对的。手工起一份部署后的脚本、把游戏窗口调到前台后问一次，回答 `{"gameRunning":true,"focused":true}`。差别在客户端：`handleLine` 的**成功分支只白名单透传** `text`/`lookupMs`/`clipSetMs`/`keysMs`/`retried`，`focused`/`gameRunning` 直接被丢掉，于是 `res.focused === true` 恒为 false。同一处白名单还让 `fg`/`win` 在成功路径上永远缺失（它们只挂在失败分支上）。
- 定位手法：给 `focus()` 加一条「回答里没有 `gameRunning` 就写 `inplace.log`」的守卫，日志立刻把异常包体 `{"ok":true,"lookupMs":0}` 打出来——比再猜三轮快得多。
- 修法：成功分支补齐 `gameRunning`/`focused`/`fgPid`/`fg`/`win`；桥里的前台判定改成**比进程号**（`GetWindowThreadProcessId` + dota2 进程列表）而不是比窗口句柄，并把 `fg`/`fgPid`/`win` 一起回传；`idle` 拍把 `fg`/`win` 写进 `capture-ticks.jsonl`，下次再有分歧能直接从遥测看到「谁抢了前台」。
- 教训：协议加字段时，成功路径的白名单会静默吞掉新字段——不报错、不超时，只是功能悄悄降级。凡是「桥答得对、调用方看错」的形态，都要配一条能自曝的守卫日志。
## 翻译记账本

- 目的：同一句话只花一次钱。「翻过就不调 LLM」是用户的原话，而且要求**双向**——自己打「你好」译成 hello 之后，队友再说 hello 就直接显示「你好」，一个 token 都不该再花。
- 存储：`node:sqlite`，文件 `%APPDATA%/<app>/translate-cache.sqlite`。一行就是一对（`a` 归一化源文、`a_raw` 原文、`b` 译文），`UNIQUE(provider, tone, a)`，外加 `b` 上的索引。选 sqlite 而不是 JSON 的理由：一次翻译要能被两个方向查到，JSON 每次写入都得整表重写（几千条以后就是每句一次全量 IO），而反查还得再建一份倒排；sqlite 两个索引就够，且本机已经因为会话历史在用 `node:sqlite`，零新依赖。
- 查询：正向按 `(provider, tone, a)` 命中；正向不中就反查 `b`，命中后交出去的是 `a_raw`（原文，不是归一化的键——否则 `gg wp` 会变成 `ggwp`）。反查不看 `tone`：语气只影响「我要怎么说」，跟「这句别人说过什么」无关。
- 语言守卫：答案必须是目标语言。交出去的是 `a_raw`，所以判据看源侧——`a_han === 1` 表示中文源，只有它等于「想要中文」时才收。少了这一步，「把 hello 译成英文」会拿到中文答案。
- 不记的两种：译文与原样相同（模型没动、或本来就该原样），以及空串。前者进了账本会把反查弄脏。
- 归一化只用于建键：`normalizeLine` 会去掉中英之间的空格（`gg wp` → `ggwp`），所以键和展示值必须分开存。
- 上限 20k 对，超了按 `last_hit_at` 淘汰最久没命中的；表结构演进过（补 `a_raw`）时，打开发现缺列就整表丢掉重建——它是缓存，不是账本数据。
- 兜底：打不开库就退回进程内 `Map`（同样是 `{a, b}` 对），翻译功能不受影响，只是重启会丢。
- 预先落的统计字段（现在没人读，但事后补不回来）：`direction`（首次方向）、`origin`（首次来源 `capture`/`reply`/`try`/`warm`/`probe`）、`last_origin`（最近一次命中来自哪个入口）、`a_len`/`b_len`（字符数）、`a_words`/`b_words`（粗略词数：汉字逐字计、拉丁按空格切）。配上 `hits` 与 `created_at`/`last_hit_at`，就够回答「哪句最常出现、谁带来的、多长」。读出口是 `translationCacheRows(limit)`，按命中倒序。
- 每次命中都会 `hits += 1` 并刷新 `last_hit_at`/`last_origin`（正向与反向都算），所以「常用度」是真实使用累计，不是写入次数。

### 不值得翻的行进了队列，纯符号和单字符最费钱

症状：账本里攒下 `???`、`。。。`、`666`、`g` 这类一对，`hits` 还挺高（队友一直刷）。

根因：过滤只判了 `hasHan`（已经是中文就不翻），没人管「根本没有可翻的文字」。真实对局里 83 条独立正文中，纯符号（`???`）与长度 1（`啥`、`g`、`?`）是仅有的两类噪声，但它们每一句都要占一次模型请求。

修法：`worthTranslating(body)` 与 `hasHan` 分工——`hasHan` 判「已是目标语言」，`worthTranslating` 判「没有可翻的文字」：既没有字母也没有汉字（纯符号/纯数字/纯 emoji）、或去掉空白后只剩一个码点，都不进队列。两条入口用同一把尺子：OCR 的 `buildEntries` 与 GSI 的 `pushMessages`，否则 GSI 路线会漏过滤。

### 模型把原文原样吐回来时，那不是译文

症状：`gg → gg`，浮层把同一句显示两遍；账本多一条 `a` 与 `b` 内容相同的一对。

根因：`translateLines` 无条件把模型返回写进账本。

修法：`sameText(a, b)` 归一化后比较（小写 + 去空白/标点/符号，`??? go` 与 `???  go!` 算同一句），相同就不记、也不当译文（这条行显示为「没有译文」）。注意它只处理「字面相同」；`gg wp` 这类缩写模型可能补全，那就照常记账。

### GSI 有明确的局末信号，就不该再靠「整屏换掉」猜

症状：第二局开头浮层还挂着上一局的话；OCR 侧的去重窗口也没清，新局开局同一句 `gl hf` 会被当重复丢掉。

根因：`resetSession()` 只有 OCR tick 里的「连续几拍完全不重叠」那一支会调；GSI 路线拿到 `POST_GAME` 时只停了捕获，没清屏。

修法：`endMatchSession()` 一个公开方法（清去重窗口 + 广播空 `CAPTURE_REPLACE`），由 GSI 的 `stopCapture` 在局末调用。OCR 那边的换局判定保留——它是猜，但猜得动；GSI 不需要猜。
### 「还在翻」和「已经废了」长得一模一样

症状：模型服务不可达（或 Key 失效）时，浮层那一行永远停在「未翻译」，既没有报错也没有超时提示。看的人无从判断是网络慢还是彻底断了。

根因：`translatePending` 只有一条 `catch` 写 `lastError`，而 `lastError` 只进面板；浮层的行对象里根本没有「失败」这个状态——`translated: null` 同时表示「还没翻」和「翻不成」。

修法：`CaptureEntry.error` 显式区分。`buildEntries` 只给**真的进了队列**的行标错（用 `attempted` 集合），中文行与不值得翻的行不背锅；浮层画 `.trans.err`（`✕ 翻译失败`，`title` 挂原始报错），面板同理。探针 `--overlay-probe` 用一条假失败行断言 `errorOk`——这条不做断言的话，回归时没人会发现浮层又开始沉默。


## 浮层几何

### 锁定、拖动、缩放、还原各自该治什么

症状（期望而不是事故）：浮层固定贴在捕获区域旁边，位置和宽度都不能改。想让它在左边一点、或者窄一点少挡画面，只能改捕获区域；而捕获区域又是随手框的，于是每次都要重新框一次。

根因：窗口位置写死在 `reposition()` 里（跟着 `region` 算 x/y/h），宽度是常量 `OVERLAY_WIDTH = 340`，`resizable: false`，也没有任何持久化字段。也就是说「几何」从来不是用户的东西。

修法，四条语义分开：
- **锁定**（`overlayLocked`，默认开）= 位置尺寸冻住 **且强制点击穿透**。默认锁着很重要：不锁就等于让一个能挡住鼠标的窗口飘在游戏上。
- **解锁**才出现工具条与两侧把手；拖动/拉伸在渲染进程算增量，`applyGeometry` 在主进程统一 `clampGeometry`。边界只在主进程收口，因为渲染进程拿不到显示器工作区。
- **还原**（`overlayBounds = null`）回到「跟随捕获区域」的默认摆放。这条和「记住位置」是配套的：正因为记住了才不会每次开机都跳回去，也正因为记住了才更需要一个一键回到默认的出口。
- 左右两个把手的不变式不同：拉右边只改 `width`、`x` 不动；拉左边**右边缘钉死**（`x` 与 `width` 反向变化）。写反了的表现是「一拖窗口就跳一下」，肉眼很难归因。

`--overlay-geometry-probe` 把这六条不变式钉成 9 个纯算术用例（另含贴边时宽度下限优先）。这类错误只在别人的屏幕尺寸上复现，靠手感发现概率太低。


## 调试方法

- 数据目录已改便携：安装版在 exe 同级 `data/`，`npm run dev` 与探针用项目根 `data/`（`src/main/services/data-dir.ts` 的 `applyPortableUserData()` 在 ready 前改掉 userData）。只有目标目录不可写（装进 Program Files）才回落系统 `%APPDATA%`；首次启动会从老位置搬一次 `settings.json` 与账本，不覆盖已有文件。
  探针读的是后者，改配置后两边都写一遍。
- `node:sqlite` 以 `readOnly` 打开看不到还在 `-wal` 里的数据；主库 mtime 旧而 `-wal`/`-shm` 新，说明写入就在这里。
- 判定「按键是否生效」只能读游戏侧的 `console.log` 增量或聊天框回读，不能靠「看起来发了」。
- 聊天框探针用哨兵法：先写哨兵值 → `Ctrl+A`/`Ctrl+C` → 读回，能区分「复制失败」和「框里本来就是空」。
- bash 里不要写内嵌 PowerShell 单行（`$变量` 会被吃掉），写到 `.tmp/*.ps1` 用 `-File` 跑；同理 `node -e` 里避免反斜杠字面量。
- 截图排查：`.tmp/shot.ps1`（CopyFromScreen 整屏）+ sharp 缩到 1400 宽后再看图，避免大图塞满上下文。

## 已知限制

- 捕获循环仍是 BETA，全屏独占下靠回落路径取帧，极端情况会慢 0.3–0.9 秒。
- 中文英雄昵称还没映射到英文缩写（影魔 → sf、火女 → lina、冰女 → cm）。
- 语音链路是骨架：录音上限 20 秒，TTS 只做试听，没有接到虚拟声卡。
- 无昵称前缀的闲聊行在 OCR 里仍可能被误合并（真实聊天每行都有前缀，风险低）。

### 穿透与锁定：两个开关描述同一件事
- 症状：解锁浮层后依然点不动、拖不动。
- 根因：穿透判定是 `locked || clickThrough`，而「点击穿透」默认开。用户解锁了锁定，按钮上明明写着「解锁」，鼠标却仍被放行给游戏——两处开关描述同一件事，用户永远猜不到要关哪个。
- 修法：穿透只由锁定决定（锁定 = 不吃鼠标，解锁 = 可拖可点），删掉独立的「点击穿透」设置项、IPC、托盘菜单项与快捷键语义，`Alt+Shift+P` 改为锁定/解锁。
- 教训：两个 UI 控件落在同一个布尔判定上时，必须合并成一个，或者让其中一个成为派生显示。否则每次改动都会踩「以为关掉了其实没关」的坑。

### 不用翻 ≠ 不用念
- 症状：GSI 正文源下，中文消息从来不朗读。
- 根因：`announceEntries` 只在 `translatePending`（翻译落地）里调用；被判「不用翻」的中文行与纯符号行走 `pushMessages` 的 `settled` 分支，只广播上屏，从没进过朗读。
- 修法：`settled` 分支同样调用 `announceEntries`；`decideSpeak` 在没有译文时退回原文正文。
- 教训：每条「提前结束」的分支都要问一句「谁负责这条的副作用」。翻译是副作用，朗读也是，漏掉的那条分支不会有任何报错。

### 朗读里的英雄名要中文
- 症状：朗读念出 `lina 说 推上路`，英文 id 混在中文句子里，听感像是在念代码。
- 根因：GSI 只给 `npc_dota_hero_lina` 这种 id，之前剥掉前缀直接念。
- 修法：`src/main/services/hero-names.ts` 内置 127 个英雄的 id → 中文名对照（取自 Dota 官方 datafeed `language=schinese`），`heroChinese()` 查不到就原样返回，新英雄上线也不会念错人。
- 没选「读本地化文件」：Steam 把 `dota_schinese` 打包进 vpk，解析 pak 的成本远大于一张 127 行的静态表。
- 浮层上仍然显示英文 id（`[lina]`）：屏幕上看得懂，耳朵里要听得清，两者诉求不同，不必统一。

### 防截屏会让浮层收不到鼠标
- 症状：解锁后拖动条带、拉两侧完全没反应，鼠标像点在空气上。
- 根因：窗口开着 `setContentProtection(true)`（`WDA_EXCLUDEFROMCAPTURE`）。它把窗口从截屏里摘出去的同时，在 Windows 上也会让部分鼠标消息不再送达该窗口——而这正是「解锁后我要操作它」的时刻。
- 修法：防护跟随锁定态——锁定（默认）开着防截屏，解锁时关掉，重新锁定时恢复。
- 顺带：外部截图工具（含我自己的桌面截图）看不到浮层，就是这条在起作用；排查「浮层在哪」时别拿截图当证据。

### 底色不透明度要给用户一个旋钮
- 症状：有人嫌浮层太实挡住视野，有人嫌太淡看不清字——同一套数值不可能同时满足。
- 修法：`#root` 底色彻底去掉，行底色改成 `rgba(12,10,9,var(--row-alpha))`，面板给滑杆（5%–90%，默认 34%）；`show()` 里每次重新声明一次全透明背景，兜住 Windows 上透明窗口偶发退回不透明底的问题。

### 朗读「一下这个声音一下那个声音」= 引擎在兜底
- 症状：同一局里音色忽好忽坏，接同一句有时是自然女声，有时是机器播报。
- 根因：Edge 免费接口失败时，代码退回系统嗓子（Windows 上只有慧慧/瑶瑶/康康这类 SAPI5 拼接音）。两个嗓子轮流上岗，听起来就是两个人。
- 实测：冷握手 1–21 秒，热连接每句 1–2 秒；连发 6 句时 4 句被限流（HTTP 429）。
- 修法：连接池（2 条长连接，跨 slot 并行、同 slot 串行）+ 启动预热；合成失败就**这一句不念**，绝不换嗓子。

### 长连接池把 Edge 成功率从 33% 拉到 100%
- 之前：每句 `new EdgeTTS()`，等于每句赌一次冷握手。实测 `--tts-bench` 10 句：成功 10/10，p50 **1186ms**，max 2016ms。
- 对比改造前同一台机器：6 句里 2 句成功、4 句 429，另有一次 21 秒 TLS 超时。
- 代价：池子只放 2 条——再多就被限流；同一条连接上的请求必须串行，否则音频会串流。

### 锁定是「不吃鼠标」，收起只是「变小」
- 症状：收起成小图标后，游戏里的点击被它吃掉；或者反过来，收起后锁定失效、想防误点也防不住。
- 根因：早期为了让「收起还能点回来」，把穿透写成 `locked && !collapsed`——把「能不能点到」和「窗口多大」绑在一起了。两件事本来无关。
- 修法：抽出纯函数 `shouldIgnoreMouse(locked, replyOpen)`，只有「锁定且不在回复」才穿透；收起不改变它。收起后要展开按 **Alt+Shift+B**（全局热键，不依赖点得到），或先 Alt+Shift+P 解锁再点。
- 教训：一个布尔判定里塞进两个维度的状态（锁定 / 尺寸），迟早会互相污染。

### 浮层交互：正常时「什么都不显示」
- 现状：锁定+正常捕获时，pill 整块隐藏——浮层是字幕，不是仪表盘。只有三种情况会出现一行字：回复框打开、配置态（未锁定）、以及「取不到字」。
- 「取不到字」由纯函数 `captureHint()` 判定，顺序固定：错误 → 没选区域 → 捕获暂停 → GSI 未进对局 → null。错误优先级最高，因为其他状态在报错时都不可信。
- 配置态（解锁）5 秒无操作自动锁回穿透：解锁是临时操作窗口，不是常驻状态。倒计时在 `OverlayManager.armIdle()`，渲染层用 `overlayKeepAlive()`（1 秒节流）推后它。
- 拖动松手时贴边吸附（`snapToEdges`，阈值 24px）：拖得再准也会留 1~2px 缝，换 DPI 就是一条亮边。
- 新行 400ms 亮黄；超过 12 行的旧行降到 55% 不透明度——保留上下文，又不糊满下半屏。
