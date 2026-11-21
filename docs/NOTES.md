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

### 按住热键「按了没反应」时，先看自检那一行（#95）

**症状**：按住热键说话，有时候像没听见；重启应用又好了，说不清到底哪一步坏了。

**根因**：按住用的不是 `globalShortcut`（它只报按下），而是一个常驻 `hotkey-hold.ps1` 轮询 `GetAsyncKeyState`。这条链有三段会各自失败：脚本没起来（PowerShell 策略、被杀）、起来了但没收到按下、收到了但松开丢了。以前三段都只在日志里各留一行，用户看不到，于是只能「重启试试」。

**修法**：`src/main/services/input/hold-selftest.ts` 成为唯一登记处（starting / resident / fallback + 原因 + 最近 24 条边），经 `hotkey:hold-selftest` 给面板；热键页的「按住检测」一行显示状态、按下/松开次数、上次按住多久。**退回敲一下时文案必须说「按住不生效」并给出敲一下的用法**——降级不是修复，不许写「已恢复」。

**探针的边界**（`--hold-watch-probe`，三段）：真脚本起来并回报 `OK` 是硬断言；假脚本按同一协议吐 `HOLD 1`/`HOLD 0`，钉住「每条边只落一次」；起不来时退回态必须带原因。**注入按键这一段在拒收 `keybd_event` 的桌面上只记 SKIP**：实测同一进程里注入后 `GetAsyncKeyState` 仍返回 0，把环境限制算成代码失败只会让人去修不该修的地方。另：`powershell -Command "<一长串>"` 在这台机器上会挂住不退出，注入脚本一律落盘用 `-File` 跑。

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
- 判据：日志干净不等于修好，必须是「画面在变」。这条只适用于已经退役的 OCR 抓屏路径：那时切手动模式连按两次「立即捕获」，两次内容相同就是冻结帧。现在正文来自 GSI，没有抓屏帧可看。

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

### 直发翻出「上一条」
- 症状：`Shift+Alt+T` 明明聊天框里打的是新的一句，发出去的却是上一条的译文；或者按了完全没反应，
  几秒后忽然冒出一句旧消息并回车发出；最糟的是那句中文彻底没了。
- 根因三条叠在一起：
  - `grab` 读完就把聊天框 `Ctrl+A` + `Delete` 清空了（`chat-inplace.ps1` 的 grab 尾部），
    那句中文此刻只活在内存里，任何失败都是永久丢失。
  - `grab` / `replace` 各自只串行「单步请求」，整条流水线（读 → 翻 → 写）没有闸门。
    两次热键可以交错成 读A → 读B（空）→ 翻A → 翻B → 写A → 写B，后写的那次把先写的那次盖掉。
  - 单句翻译最坏几十秒（回合排队 + 对冲 + 重译），而热键路径 `void translateInPlace()` 把返回值丢了：
    用户以为没成功，重打重按，于是又开了一条流水线。
- 修法（`src/shared/inplace.ts` 是纯决策缝，主进程与探针共用）：
  - 再按一次热键 = **打断上一次**：`breakInPlace()` 清掉当前这趟并 `abortTranslation('reply')` 掐掉模型回合
    （不掐它就一直占着回合锁，重按的那次照样排队）。还没写回的中文作为 orphan 交给下一次；
    新的 `grab` 拿到 `NOCONTENT` 且手里有 orphan 时继续翻那一句，而不是报「没有读到内容」。
  - 写回前的三道闸门 `decideInPlaceDelivery`：被打断 → 什么都不做；没翻出英文 → 回贴原文；
    超过 20 秒（`INPLACE_STALE_MS`）才回来 → 也算过期，回贴原文。只有「没被打断 + 有英文 + 没迟到」才写回。
  - 失败一律把原文粘回聊天框（`send` 分支新增 `enter:false`，只贴不回车），并把
    「原文已放回聊天框 / 没救回来」写进结果（`InPlaceResult.restored`）；面板据此提示，浮层用 `flashHint` 显示 6 秒。
  - 打断不是失败：`durable-translator` 里改成按来源打断（`abortTranslation('reply')`），
    被打断的回合抛 `TURN_CANCELLED` 且不记冷却、不写记账本、不触发直连兜底 ——
    否则下一次直发要白等 30 秒，看起来就是「按了没反应」。
- 复查命令：`--inplace-guard-probe`（纯决策，不碰游戏与输入桥）。

## 语音

### 断网重下从头再来、镜像坏了查不出是谁（#79）

**症状**：操蛋的网络下 986 MB 底模，断一次就从 0 开始；面板只说「下载失败」，说不清是直连被掐还是某个加速前缀坏了。

**根因**：下载逻辑曾经散在四个口子里各写一遍，谁都没做这件事：续传要看服务端认不认 `Range`，认了才能从 `.part` 接着下；不认的时候盲接残片会把两份字节叠成脏文件。镜像表也只有前缀列表、没有「这次到底走的谁」的记录。

**修法**：`src/main/services/net/download.ts` 是唯一入口。`downloadResumable` 先 `Range: bytes=0-0` 探一针，认 Range 且文件够大就走 `downloadParallel`（每段一个 `.part-<i>`，段文件大小即该段进度，断点按段对账），否则退回单流续传；服务端不认 Range 就**从零重下**（`onLog('RESTART')` 会记这件事），下完原子改名。`tryMirrors` 依次试直连与加速前缀，**用上镜像时打一行 `DOWNLOAD_MIRROR`**（prefix / url / candidate）。全挂时抛的不是「下载失败」也不是裸错误串，而是 `src/shared/download-failure.ts` 判过归属的一句：连接被掐/断流/超时算「网络」（换镜像还有救），HTTP 状态码/尺寸不符/哈希不符算「源站」（换哪个镜像都白搭）——这两类的处置完全相反，混成一句等于让用户去撞墙。

**探针**：`--download-probe` 在 127.0.0.1 上起一个「写 96 KB 就断」的服务端，断言四件事——残片留在 `.part` 里；第二次请求的 `Range` 起点正好等于残片字节数（不重下）；不认 Range 的源重下后内容逐字节正确且没有残留段文件；坏镜像掉到下一个并让 `DOWNLOAD_MIRROR` 点名真正给字节的那个。全部离线，临时目录跑完即删。

### 对局里标的那一句，换局之后还得读得到（#118）

症状：复盘想看「我当时标的那几句」，但星标只在内存里活到对局结束，换局即消失；或者更糟——按局读的时候把别的局的星标也算进来，复盘里混进别人的句子。

根因：星标只记了行号没记归属。`liveMatchId()` 只认 90 秒内的活帧，拿不到就只能是 null；把 null 当「全部」是这类统计最容易犯的错（和译文抽检的「末尾即最新」是同一类错）。

修法：`src/shared/replay-star.ts` 一处定口径——`buildStar()` 空原文/空译文/空行号一律不造样本，`matchid` 空白写显式 null；`starsOf(stars, matchid)` 只返回**精确匹配**那一局，null 是单独的「归属不明」组；`dedupeStars()` 同一行只留一条、取最后一次。落盘 `logs/replay-stars.jsonl`（`appendCappedJsonl`，256 KB）。

验收：`--replay-star-probe` 26 条。关键是跨边界那条——先在 M1 标两条、再在 M2 标一条，`replayStarSummary('M1').total === 2` 且 `('M2').total === 1`；从没标过的 M3 读出来必须是 0，不是全部。

### 缺虚拟声卡看起来像「输出坏了」（#90）

**症状**：队友一句都听不到，面板只说「声出异常」；用户以为是播放器坏了，反复装驱动、重启应用，甚至把真扬声器设成输出顶着用——那样队友更听不到。

**根因**：VB-Cable 有三个互相独立的状态，混成一句就成了死胡同：驱动包在、音频端点在、用户有没有把输出设备指到 CABLE。旧面板把前两种情况都报成同一句，用户不知道下一步该装、该重启还是该改设置。还有一个更隐蔽的：驱动装完内存里的设备清单不会自己刷新，`enumerateDevices()` 里压根没有 CABLE 端点——这时给一个「设为输出」按钮，写进去的 deviceId 是空串，点了没反应。

**修法**：检测与缺口判定分成两层。`src/main/services/voice/virtual-cable.ts` 只回答「驱动在不在、端点在不在」，靠 PowerShell 读 `MMDevices` 注册表 + `Win32_SoundDevice` + SCM 服务状态，不碰麦克风、不要授权（`execFile` 可注入，探针喂假 stdout）。`judgeCableGap()`（在 `src/shared/voice-out.ts`）把「状态 + 当前选的设备 + 清单里的 cable 端点」收敛成**一句缺口话 + 唯一一个按钮**：没装 → 一键安装（附「怎么装…」）；驱动在端点没出现 → 只说「重启一次电脑再检测」，不给安装按钮（再装一次没用）；装好没选 → 设为输出；驱动在但清单里还没枚举到 → 只说重新检测（**不给人写不进 deviceId 的按钮**）；检测本身没跑成 → 说「没查成：原因」，绝不当成缺驱动去装。`src/main/services/voice/virtual-cable-install.ts` 的每一步可注入，失败时返回 `step: 'page'|'download'|'extract'|'elevate'` 并打 `VCABLE_INSTALL_FAILED`，用户与日志都能看到卡在哪一步。

**探针**：`--voice-out-probe` 里 4 条安装步（假依赖逐个 reject，断言 `step` 与文案）、6 条缺口、4 条检测归类。**注意**：安装步的用例必须换到临时目录跑——真实 `data/vb-cable/` 里已经放着装好的 `VBCABLE_Setup_x64.exe`，`existsSync` 一真就跳过了下载与解压两条腿，于是这三步永远假绿（2026-11-21 就是这么被逮到的）。

### whisper 模型下载只有 43KB/s
- 根因：hf-mirror 对单连接限速。
- 修法：先 `Range: bytes=0-0` 取总长度，再 16 路并发 Range 下载分片、顺序拼接（实测 3.7MB/s，141MB 约 40 秒）。

### 系统嗓子念中文像播报，换 Edge 神经语音
- 症状：朗读能出声，但中文只有一个「慧慧」（Windows 自带的拼接音），念游戏聊天像地铁报站。
- 根因：`speechSynthesis` 的音色由系统安装的语音包决定，Windows 中文就那一个；想换嗓子只能换引擎。
- 修法：主进程用 `@andresaya/edge-tts`（微软免费的朗读接口，无需账号）合成 mp3，base64 下发给浮层用 `Audio` 播；合成失败/超时 4 秒就**退回系统嗓子**，绝不静音。设置里 `ttsEngine: 'edge' | 'system'` + `ttsVoice` 选嗓子，面板给「晓晓·温暖 / 晓伊·沉稳 / 小北·东北话」。
- 踩坑：`msedge-tts` 这个库连上去回 401/200（协议改了，需要 `Sec-MS-GEC` 且旧 token 失效），同一个地址 `@andresaya/edge-tts` 能通，实测 19 KB mp3。**判断「接口还活着」要拿真实合成结果，不要拿 HTTP 状态码。**
- 两个嗓子是两条路：`system` 全离线（断网可用）；`edge` 联网但好听。都保留了。


### 第四引擎 GPT-SoVITS：零样本克隆 + 应用自动拉起 api_v2
- 背景：sherpa-onnx 系离线模型全轮试听否决（vits 12 包、kokoro、melo「声音太弱」peak 0.10≈-20dB）；用户要「Edge 晓晓式温柔妹妹声」，最终路线 = GPT-SoVITS 官方整合包（`D:\AI\GPT-SoVITS-v2pro-20250604`，魔搭直链免代理）零样本克隆：用 `synthesizeEdge` 合成 5 秒晓晓样音当参考音频（`D:/AI/ohmydota2-ref/ref1.mp3`）+ 逐字转写，音色即克隆。
- 修法：`sovits.ts` GET api_v2 `/tts`（失败 null 静默跳过，绝不回退系统嗓子）；`sovits-server.ts` 在 `ttsEngine === 'sovits'` 时 app ready 即拉起整合包 `runtime\python.exe api_v2.py`（TCP 轮询等就绪，实测 13.6s），退出 `will-quit` taskkill 树杀；端口已被占就复用外部实例。设置四件套：`ttsSovitsHome`（目录，自动拉起的开关）/`ttsSovitsUrl`/`ttsSovitsRefAudio`/`ttsSovitsPromptText`。
- 踩坑（两个都 400/静默）：Windows GBK 控制台把真实异常吞成 `'gbk' codec can't encode '\ufffd'`，必须 `PYTHONIOENCODING=utf-8`；ffmpeg.exe 在整合包 `runtime\` 里，不进 PATH librosa 解不开 mp3 参考——spawn 时 PATH 前置 runtime。
- 延迟（RTX 4060 Laptop）：模型加载 ~14-40s（应用启动即拉、不等第一句）；热句 2-5s/20 字。参考转写与音频对不上会明显劣化，转写必须逐字。
- 慢在哪儿以及两个实测优化（2026-10-27，同一句 11 字用 curl 量 p50）：`batch_size=8` 让解码成批走 → 11 字 1.96→1.23 s、22 字 3.37→1.91 s；服务 READY 只代表端口开了，**第一句真实合成还要付一遍 CUDA/懒加载 4.6–5.5 s**，所以起服后立刻合成一句「预备」扔掉（`TTS_SOVITS_SERVER_WARMUP` 记耗时），把这笔代价挪到还没人说话的时候。
- 参考音频硬限制：api_v2 要求 **3–10 秒**，否则 400 `参考音频在3~10秒范围外，请更换！`；把试听成品（1–2 s）当参考就是这条错误的来源。克隆的克隆还会让音质二次劣化。

### 朗读「只念别人说的」这条不能加
### gv 提速收口：服务端地板是解码 compute，不是参考重编码
- 背景：sv（StreamVox）试后弃用，主推 gv 提速。先量地板：api_v2 小节请求（4–10 字）**每请求 ~1.0–1.3s 且与长度基本无关**——地板不在文本长度，也不在应用链路。
- 排查：`TTS.py set_ref_audio` 每个请求都重跑参考音频编码（librosa 加载 + huHuBERT 前向 + extract_latent + 频谱），一度被当成地板大头。给它加了「路径+mtime 命中即复用」的缓存补丁实测：三轮取每句最小值，均值 972ms vs 未打补丁 1166ms——**只省 ~150–200ms，且被 ±300–500ms 的显卡热噪声淹没**（同一句跨轮 775↔1496ms），低于 300ms 门槛，补丁回滚。
- 结论：地板是 t2s 自回归解码本身的 compute，服务端没有便宜的优化空间。真正值钱的刀在应用侧，且此前都已就位：预切句（≤20 字逐段请求）、下一段预取、起服后「预备」预热（第一句真实合成的 4.6–5.5s CUDA/懒加载代价早已挪到没人说话时）。应用真实首包 ~1.2s，对比整句直打的 1.9–2.5s。
- 教训：优化前先量地板构成，别对着「看起来重复的活」下手——每请求重编码听着很浪费，实测只占两成；热噪声 ±300–500ms 的环境里，单轮 A/B 数字不可信，至少三轮取最小值。
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


### 朗读前缀「某某说」三态：句首 / 句尾 / 不念（ttsSpeakPrefix）
- 需求演进（2026-10-27–28）：先要「能关掉」，再要「[内容] 【玩家x/我】 说」——内容在前、说话人收尾。
- 修法：`ttsSpeakPrefix: 'front' | 'back' | 'off'`。`decideSpeak` 里候选人照常算（我 / 英雄名 / 座位标签），`off` 时整体置空（和「没有标签」同一条路径，不多出逗号或半截停顿）；`back` 时拼 `${body}，${spoken}说`。面板一个循环按钮「说话人：前面 / 后面 / 不念」。
- 类型迁移：字段从 boolean 改三态，`loadSettings` 里从 `parsed as Record<string, unknown>` 读原始值归一化（true→front、false→off）——直接在 merge 后的字段上比 boolean 会撞 TS2367，运行时又真可能躺着旧值。
- 判据钉在探针 `TTS_SPEAK_PREFIX_CASES` 六用例：front（我说，/影魔说，）、back（推上路，我说 / 中路没人，影魔说）、off（推上路 / 为什么，座位标签也不念）。
- 教训：这类开关要作用在**前缀整体**，不是逐个分支加条件——三个来源（own / speaker / 座位标签）漏一个，关掉后照样念得出「玩家2说」。

### 浮层收起/锁定/隐藏要跨启动记住（overlayCollapsed / overlayVisible）
- 需求（2026-10-28）：「记忆收起、锁定、隐藏，在下一次启动的时候按这个来」。
- 修法：锁定本来就有 `overlayLocked` 持久化；补 `overlayCollapsed`（toggleCollapse 两个分支各自 saveSettings）和 `overlayVisible`（toggle 藏时写 false；show() 亮出后写 true）。启动时 `whenReady` 里 `startup.overlayVisible` 为真才 `show()`——浮层从不自动弹出，只还原用户上次的选择。收起态下 show() 先 reposition 再套 `miniGeometry`，重启见面也是小图标不是整块。
- 教训：显示状态要在「用户动作发生的当下」持久化（toggle/show 里），而不是退出时快照——强制退出（dev:stop 的 Stop-Process）不走 will-quit，退出时快照必丢。
### 「看一眼画面」按下去要能说出为什么不行（#135）
- 症状：想看「现在这波该怎么打」，只能自己截屏、开网页、贴图；应用里没有任何入口。
- 根因：`ChatMessage.content` 是字符串，provider 这层根本发不出图；截屏链路（OCR）早被移除，`desktopCapturer` 一处都没用上，所以票面写的「已经能截屏」是过期的。
- 修法：`content` 扩成 `string | ChatContentPart[]`；`src/main/services/vision.ts` 用 `desktopCapturer` 一次取一帧（第一帧为空重试一次），调 `chatCompletion`，答案广播回呼出面板的「看一眼」页；热键 `visionAsk`（默认 `Alt+Shift+G`）先开面板再截图。
- 三个不许含糊的地方：图片只走 data URL（不写盘、不进 `logs/`，探针用目录前后一致钉住）；模型名不像视觉模型时说的是「去对话页换一个能看图的」，不是「不支持」；截不到画面时说的是「这一帧是空的（受保护窗口、桌面锁着，或这个会话拿不到桌面）」——三句不同的话，用户才知道该改哪。
- 实测：`--vision-probe` 15/15；本机那个 bash 会话里 `desktopCapturer` 拿到的帧是空的（与「`keybd_event` 注入被拒」同一类现象：那个会话不是真正的交互桌面），所以截图那一步记 `skipped` 并把原因打出来，而不是假装通过。
### 小地图血点：能测的只有耗时与聚类，准确率还没测（#134）
- 症状：想「从截图上数出对面几个人」，听起来像个下午的活，实际上一句话就能问倒它——谁的点算英雄？小兵、幻象、肉山、被战争迷雾挡住的，全都在同一张图上，颜色还一样。
- 能测的（已测，`--minimap-probe`）：**一帧 262×262 的检测耗时 0.356 ms**（中位数，40 次）；**整帧 1920×1080 先判再裁 18.52 ms**（6 次）——所以「每帧都跑」这件事在耗时上不是瓶颈，真正的问题在别处。聚类本身在合成帧上是对的：两块红点各自成点、质心落在方块中心、1 像素噪声被面积门槛（`minRed`/`minGreen` = 12）滤掉、门槛调高能全滤掉。
- 不能测的：**准确率**。需要带标注的真实小地图帧（英雄 / 小兵 / 幻象 / 肉山各多少、在哪），仓库里一张都没有；用合成帧算出来的数字只能证明代码不傻，不能证明它认得游戏。探针输出里显式写 `accuracy: "unmeasured"`，`autoLocate` 同样未测（多分辨率、HUD 缩放下小地图位置怎么找，需要真实截图）。
- 补测条件（写在这里，免得下次重新想）：把带标注的截图放进 `<userData>/logs/minimap-frames/*.png`，探针就会从 `unmeasured` 转成按张计数；标注格式还没定，定之前不要写解析器。
- 口径：不要因为「检测很快」就承诺英雄计数——快的是找红绿像素，难的是判断那个点是谁。真要上功能，先拿 20 张真实帧把准确率量出来，再谈。
### 主进程崩了，用户手里只有一句截图不下来的英文框（P3）
- 症状：主进程里一个没接住的错误，Electron 弹「A JavaScript error occurred in the main process」，用户看不懂、复制不出来，我们收到的是「刚才闪了一下」；进程直接没了的更彻底，什么都不留。
- 根因：`process.on('uncaughtException' | 'unhandledRejection')` 一个都没装。这不是「没做界面」的问题，是先没有证据可展示。
- 修法：`src/main/services/error-log.ts` 在 `app.whenReady()` **之前**装两个钩子（早于窗口的错误同样要留证据），把 `{at, kind, message, stack, context}` 追加进 `logs/errors.jsonl`（256 KB 上限、整批 `appendCappedJsonl`），内存里留最近 50 条；归类与「一句话摘要」放纯缝 `src/shared/error-log.ts`。钩子**不吞异常**：Electron 自己的框照旧弹，我们只多留一份。写日志失败就静默放过——记录异常的代码把异常抛出去是第二种事故。
- 面板：关于页「诊断 → 最近的错误」念一行「N 条异常 · 最近 HH:MM:SS · 最常见：…（M 次）」，下面按类分组列次数与处境（`translate:session`、`provider`）。没有就说「没有记录到异常」，不写「一切正常」——没记录不等于没发生。
- 怎么验：`--error-log-probe`（21 条）钉住「什么算一条」（`Error`/字符串/带 message 的对象/认不出退化成 JSON/空串不记）、同类同句合并计数、`top` 截断但 `distinct` 仍是实数、上限只留最近 50 条、以及探针自己那份日志落在临时目录。
- 没做：渲染层错误还没有 IPC 回传（`window.onerror` → 主进程），需要时再加一条通道；也没有「按严重程度分级」，缝里判断不了一行代码正在干什么。
### 探针把假数据写进了真实日志（#126）
- 症状：跑过 `--match-attribution-probe` 之后，`data/logs/gsi-summary.json` 里躺着 `matchid 9100000002`、`frames: 2`——下一局真对局开始时，代码看到「matchid 变了」就把这局**假对局**归档成上一场，复盘页从此多一局没打过的比赛；`--voice-chain-probe` 更直接：它先把真实的 `voice-chain.jsonl` 清空再写自己的两行，玩家的对讲计时记录就没了。
- 根因：日志路径统一走 `logsDir()`（`src/main/services/logs/base-dir.ts`），但「探针要不要换根」这件事**没人负责**——每个探针自己记得 `setLogsDirForProbe()` 才行，而人总会忘。`resetFrameSummary()` 只清内存账本，注释写着「不影响已落盘的文件」，所以假 summary 会一直躺在盘上。
- 修法：把「探针不碰用户数据」变成进程级的默认值——`src/main/index.ts` 在 `applyPortableUserData()` 之后立刻判断：如果本次是以某个探针标志启动的，`setLogsDirForProbe(mkdtempSync(tmpdir/'omd2-probe-logs-<flag>-'))`。想用真目录必须在那张表里显式标 `realLogs: true`（现在只有 5 条：读上一局真日志的 `--gsi-dump-report`/`--match-report`、产出给人回放产物的 `--gsi-dump`/`--interpret-listen`、读人手工放素材的 `--minimap-probe`），而且它们只读不写。同时把 `gsi.ts` 里四处直接拼 `<userData>/logs/...` 的写法（`gsi-chat`/`gsi-player`/`gsi-draft`/`gsi-stall`）收进 `logsDir()`，否则这一层缝漏掉一半。
- 怎么验：新探针 `--logs-isolation-probe`（ci）断言 `logsDir()` 不在 userData 下、summary 活文件与归档目录都跟着临时根走、写两帧之后真实 `gsi-summary.json` 逐字节不变、白名单少于总数一半；另外把 31 条 CI 探针串起来跑一遍，跑前跑后 `sha1sum data/logs/*` 完全一致——后者是唯一能证明「不漏」的证据，单看某条探针的断言不算。
- 教训：这类「默认值靠记性」的缝要用框架层兜住，不是给每个调用点加一句记得改；而且改完必须有一份**跑完整套之后仍然成立**的证据，因为漏的那一条往往就是你忘了改的那条。
### 浮层字小、灰度下分不清已播未播（#100）
- 症状：浮层文字只有一套大小（原文 12px / 译文 13px），想看清只能坐近一点；已播行与未播行只靠绿色和灰色区分，灰度截图、色弱用户、甚至投影仪偏色时看着一模一样。
- 根因：字号与颜色全是 `src/renderer/src/overlay/overlay.css` 里的字面量，26 处 `font-size` 只有 10/11/12/13 四个数，没有任何地方能检查「对比度够不够」「状态有没有非颜色标记」——它既不在类型里，也不在探针里。
- 修法：像素与颜色表搬进 `src/shared/overlay-a11y.ts`（`FONT_SCALE` 三档、`OVERLAY_TEXT_PAIRS` 十五对、`OVERLAY_STATE_MARKS` 十条），CSS 只留四个变量 `--ov-fs-mini/small/body/title` 由根节点 `data-font` 切换（normal 与改动前逐像素一致）；`.spoken.ok` 加 `✓ `、`.spoken.err` 加 `✕ `、阶段行警告加 `⚠ ` 前缀，颜色不再是唯一信号；`check:pure` 守一道漂移——CSS 里不许再有字面量 `font-size`，三组像素必须等于 `overlayFontScale()`。
- 口径：探针算的 AA 是「文字相对**行底色叠纯黑**」的比值，最差一对 `.panel-note` 5.79:1；亮场景靠 `text-shadow` 兜，那个离屏算不出来。所以结论只能是「在自家底色上达标」，不许说成「任何游戏画面都看得清」。
- 教训：`scripts/gen-probes-md.mjs` 的 flag 正则原来是 `[a-z-]+`，`--overlay-a11y-probe` 因为带数字被整行漏进 `docs/PROBES.md`，而 `--overlay-geometry-probe` 的摘要用双引号（含 `overlay's`）只认单引号的解析器又把它变成空行——两处都不报错，靠 `check:probes` 的行数差才发现。
### 静音时 whisper 输出 `[BLANK_AUDIO]` 幻觉
- 修法：录音段取**最响的那 100 毫秒**的音量（不是整段平均——按住两秒只说一个词，平均值会被前后静音拖到阈值下）：低于 0.0005 判「麦克风没有声音：检查输入设备」（数字静音：端点选错、系统没授权、设备静音键），低于 0.012 判「没有检测到语音」，都直接丢掉这段并留一行 `VOICE_CAPTURE_REJECT`；转写结果再过滤 `[BLANK_AUDIO]` 等标记。
- 实测（2026-11-14）：`data/asr-ft` 里 86 条真实说话的录音，整段平均最小 0.0216、最响 100ms 窗最小 0.0782——两者差 3.6 倍，用平均判会把「说了一个词」判成没说话。


### 热词被当成识别结果（Qwen3 把提示念了一遍）

- 症状：对讲说一句话，转写出来的不是话，而是热词表本身；两种形态都出现过——带分隔符 `"肉山 野 野怪 上路 中路 下路 神符 符 打钱"`，和**连成一串** `"肉山野怪上路中路下路神符打钱。"`。译文和声出跟着念这段表。
- 根因：热词在 Qwen3 里是**解码提示**（构造期 `hotwords`，sherpa 把它放进上下文），不是「说过的词表」。一段只有底噪、没有说话音的录音，模型就顺着提示把整张表吐出来。实测（2026-11-13，`qwen3-asr`，16 kHz）：纯静音 0.3/1/2 s → 空串（空表与满表都一样）；白噪矩阵 9 组里 5 组吐出整表、4 组空串，形状随机（0.01/0.6 s 那一组就是无空格的粘连形态）；同一条音频换空表 → 空串。有讲话音的 12 条真录音对照：2 条输出变化，都是变好，没有一条把热词吐进结果——所以这不是「热词表太大」，而是「没有话音时必须判成没有」。
- 修法两层，缺一不可：
  1. `hotwordPrompt()`（`src/shared/asr-hotwords.ts`）：喂给引擎前剔掉单字（`野`/`符` 几乎匹配任何句子，偏置最强）与被更长词包含的词（`野` ⊂ `野怪`），再按 24 条封顶。只降偏置，**不解决**回声——过滤后的表照样被试出来。
  2. `hotwordEcho()` + `transcribeAsr` 的闸：判据要覆盖两种形态，只认片段会漏掉连成一串的那种（第一版只认片段，线上真正看到的就是粘连形态）。带分隔符：切成 ≥2 片、每片都在表里、覆盖一半以上；粘连：去掉标点空格后用 DP 看整串能否**恰好**拼成表里的词（`coverByWords`，贪心会先吃长词再拼不上），且用到的词 ≥3（避免「肉山野怪」这种两词真实短句被误杀，除非表本身只有两三个词）。命中即 `console.log('ASR_HOTWORD_ECHO …')` 并按空串返回，走已有的 skip 路（不翻译、不声出、不进纠错样本）。
  3. 分隔符也是偏置的一部分（2026-11-13 补测，18 条无话音音频，同一张 7 词表）：ASCII 逗号 14 条吐表、全角 `，` 8 条、顿号 `、` 6 条、空表 0 条。真语音 12 条上与空表比：全角改好 1 条（`想象装` → `想象中`），ASCII 逗号与顿号各改错 1 条（`滑` → `花`）。所以提示串改用全角逗号（`hotwordPrompt` 里 `join('，')`），存储格式 `joinHotwords` 仍是 ASCII 逗号——两件事，不要合并。
  4. 被拦下时给一句人话：`transcribeAsr` 回 `dropped: 'hotword-echo'`，`transcribeWav` 翻成 `note`（`听到的是热词表，已丢弃（没听到人声）`），浮层按 `error ?? note ?? '未识别到语音'` 显示。否则用户看到的和「真没听到」一模一样，没法判断闸到底有没有生效。
- 试过但否掉的：回声后用空表重跑一次。worker 只缓存一个识别器（键含 `hotwords`），空表与非空表来回切就是反复整体重载 Qwen3（秒级），两条都缓存又太吃内存；想彻底消灭这一类，最省事的开关是引擎表里 qwen3 那行改成 `hotwords: 'none'`（代价：12 条真语音里少 1 条被热词改对的）。
- 教训：提示类「偏置」参数必须配一条「输出看起来像提示本身」的判据；判据要照着**实际看到**的形态写，不能照着第一次复现的形态写——空格在模型输出里不是契约（同一张表，9 组噪声给出 3 种文本形态）。

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

### 声出合成失败的提示要按引擎给（「断网」别误报给离线/GV 用户）
- 症状：一键到底合入后，浮层把合成失败一律写成「Edge 合成失败（断网或接口不可用）」——离线/GV 引擎失败时用户按提示去查代理，方向全错。
- 根因：集成修复前 `runReplyInner` 写死了 Edge 世界的提示串；三个引擎的失败原因域根本不同（Edge 是网络，离线是模型没装好，GV 是 api_v2 不在或参考没配）。
- 修法：`SYNTH_FAIL_HINT: Record<VoiceOutEngine, string>`（`src/main/services/voice/voice-out.ts:41`）按引擎各给一句：`edge: 'Edge 合成失败（断网或接口不可用），这句不出声'` / `offline: '离线引擎合成失败（模型没装好或推理失败），这句不出声'` / `sovits: 'GV 合成失败（api_v2 不在或参考没配），这句不出声'`。
- 教训：用户可感知的错误文案是接口的一部分，跟着引擎走，别在共享路径里写死某一个引擎的病因。

### 说话键必须有松键保险（ENDED 丢了不能把键按死）
- 症状（推演）：声出播放页崩了或导航走，`VOICE_OUT_ENDED` 永远回不来，说话键就永远按着——游戏里变成长开麦，比哑掉严重得多。
- 根因：按键链路是「主进程 down → 渲染页播完 → ENDED 回来 → 主进程 up」，中间任何一环死了，up 就没人发。
- 修法：`pttWatchdogMs = Math.max(5000, holdMs * 2 + 4000)`（`src/shared/voice-out.ts:196`）：`waitEnded` 超时即强制松键；同时 `finally` 里无条件 `releaseKey`，播完的尾巴仍是 `PTT_MARGIN_MS = 200` ms。单事件 down/up 走 ptt-key.ps1 的 SendInput，4 s 无确认判 `keyError`（此时音频照播但 `spoken: false`）。
- 教训：跨进程的「播完了」不能当可靠信号用，按住的每一个键都要有独立的、比正常时长大几倍的松键兜底。

### 输出设备路由：deviceId 命中 → label 兜底 → 都不中回退默认并提示
- 症状（推演）：重插 USB 声卡/更新驱动后 Windows 会给设备发新的 id，按 id 精确匹配就再也选不中，声出哑掉且用户不知道为什么。
- 根因：设备枚举 id 不稳定，label（「CABLE Input (VB-Audio Virtual Cable)」）才是人认得、重插也不变的那个。
- 修法：`resolveOutputSink`（`src/shared/voice-out.ts`）空请求 = 系统默认；先按 deviceId 匹配，不中再按 label 匹配；都不中回退 `DEFAULT_SINK_ID` 并带 `SINK_FALLBACK_HINT = '找不到已选的输出设备，已回退系统默认输出'`（浮层提示），面板下拉对已保存但未接入的设备显示「（已保存，当前未接入）」。
- 教训：设备选择保存的是偏好不是句柄，路由决策必须「尽力命中、失败可闻」，哑掉不如回退。

### 声出音色清单是独立清单，别和朗读下拉混（英文嗓读中文会回空音频）
- 症状（推演）：把 `VOICE_OUT_VOICES`（en-US-JennyNeural / en-US-AnaNeural）塞进朗读音色下拉，用户选它读中文 → Edge 念不了中文回空音频，还以为是引擎坏了。
- 根因：两个用途的嗓音域不同：朗读是中文域，声出是英文域；声出的 GV 音色更特殊——音色由音色包参考音频决定，下拉本身是禁用的。
- 修法：`VOICE_OUT_VOICES` 独立维护，默认 `en-US-JennyNeural`；`normalizeVoiceOutEngine`/`resolveVoiceOutSynth` 把引擎三选一（edge/offline/sovits）钉死在 `src/shared/voice-out.ts:46`，垃圾值回退 `edge`。
- 教训：两套「音色」长得像，但域和失败模式不同，独立清单 + 独立默认值比共享下拉便宜得多。

### 声出播放页的 START 监听要挂在模块顶层（多段播放不重建页面）
- 症状（推演）：分段播放时把 `VOICE_OUT_START` 监听器注册在每次播放的流程里，隐藏窗口页面是复用的、不重载，监听器一层层叠上去，一段播放触发 N 次回调。
- 根因：页面常驻复用是刻意的（省加载时间，READY 总预算 15 s 经不起每次重放），副作用是「注册一次」的时机只有模块加载这一次。
- 修法：`src/renderer/voice-out.ts:138` 起 START 监听器挪到模块顶层，只注册一次。
- 教训：复用的页面里，事件注册看生命周期不看出错时机——「谁常驻谁注册」。

### GV 中文包念英文整词吞字（正式方案前只能 Edge 英文嗓占位）
- 症状：2026-10-31 跨语种实测，风行者中文微调包直接读英文，整词吞字，完全不能听。
- 根因：微调包的音素/语言域是训练数据决定的，中文包没有英文音素的覆盖，「凑合读」读不出人话。
- 修法：英文声出用 Edge 英文神经嗓占位（`en-US-JennyNeural`）；GV 英文音色包训练是应用外前置，训练好后在面板把声出引擎切到 GV，走现有音色包权重切换，应用侧零改动（`ttsOutEngine: 'sovits'`）。
- 教训：跨语种不能硬喂，音色包的语言域是硬边界；过渡方案的默认值要选「今天就能用」的那个。

### 并行票合并会文本自洽、类型不自洽（TS2552 在集成 HEAD 才爆）
- 症状：t-05（一键到底）+ t-07（引擎选择）各自工单门禁全绿，合并后 typecheck 红：`src/main/services/voice/voice-out.ts(269,33): error TS2552: Cannot find name 'DEFAULT_VOICE_OUT_VOICE'. Did you mean 'VOICE_OUT_VOICES'?`。
- 根因：t-07 删掉了 t-04 时代的常量（引擎改由 `resolveVoiceOutSynth(engine, voiceKey, line)` 解析），t-05 是照 t-04 世界写的、还在引用它；git 的文本合并把两边的函数体自动拼在一起，文本上无冲突、类型上撞车。
- 修法：集成时把 `runReplyInner` 改为按段 `resolveVoiceOutSynth(settings.ttsOutEngine, '', segment)` 解析引擎，探针只断言解析后的计划；顺手把写死的 Edge 提示换成上面的 `SYNTH_FAIL_HINT` 表。
- 教训：每张票的门禁只在「自己的分支 + 自己的基线」上有效，**合并后的 HEAD 必须重跑全套门禁**，文本合并成功不等于语义合并成功。

### 评审遗留小账（声出，已知、暂不动）
- `src/renderer/src/overlay.ts:99-107` `setTranslation` 把 stage=translate 的失败一律画成「✕ 翻译失败」，真实原因在 title 悬停里——渲染层已预过滤大部分，纯防御路径，暂不改文案（改了要动三态渲染）。
- `src/main/ipc.ts:64` 的 `'翻译失败'` 死分支与 `src/renderer/src/overlay.ts:561` 的死三元：不可达代码，留给下一次大改一起清。
- `delay()` 在 `src/main/windows/voice-out.ts:17` 与 `src/main/services/voice/voice-out.ts:31` 各有一份：两行工具函数，抽取的收益不如多一次跨模块耦合。
- 教训：评审的 P2 逐条记录、逐条决策（修/不修 + 为什么），比默默留着强——下次动到同一片代码时有账可查。

### 开麦把蓝牙耳机切进通话模式，游戏声音断一两秒（讲话卡顿的元凶）

- 症状：按语音键讲话时 Dota 2 卡一下、**游戏声音彻底消失 1–2 秒**，松手之后还会再卡一次。收起浮层、换合成引擎都没用；朗读（不开麦）正常。
- 排除：性能采样里 CPU 从没超过 50%、GPU 63%、显存几乎不动——机器根本没饱和，不是合成也不是识别吃满 CPU。注意 `Win32_PerfRawData_PerfOS_Processor.PercentProcessorTime` 是**反向**计数器（累计的是空闲时间），拿它算 busy 会得出完全相反的结论；逐核 busy 要用 `PercentIdleTime`，单进程占用用 `Get-Process .CPU` 差值。
- 根因：`openMicStream()` 第一步是不带 deviceId 的 `getUserMedia({ audio: MIC_CONSTRAINTS })`，打中的是系统默认输入。默认一旦是蓝牙耳机（本例 LINKLIKE Cloudpods），Windows 就把整条蓝牙从音乐模式（A2DP）切到通话模式（HFP），正在放的游戏音频被掐断；随后代码再换成「麦克风阵列」重开一次，蓝牙切回 A2DP——**一次对讲断两下**，音频引擎两次重配，也就卡两下。
- 修法两层：系统层把「声音输入」默认改成内置麦克风阵列，立刻不卡（用户实测）；代码层让这件事不依赖系统设置——`src/renderer/src/lib/mic.ts` 用 localStorage 记住上次选中的 deviceId（键 `oh-my-dota2.captureDeviceId`），之后直接 `deviceId: { exact }` 开麦，不再先碰默认设备；`warmMic()` 在浮层入口 `src/renderer/src/overlay/overlay-main.tsx` 预热一次，把「第一次的代价」挪到开局前。缓存失效（设备拔掉）时清掉缓存、退回原来的探测流程。
- 教训：**蓝牙耳机的麦克风和它的音乐输出是互斥的**，任何「临时开一下麦」的代码都会让用户听到断声。这类问题看症状就能分辨：声音**彻底**消失一两秒再回来是链路重配，不是增益或缓冲的小抖动。另外 `default` / `communications` 只是伪设备，真正可用的是「麦克风阵列」——`pickCaptureDevice` 本来就选对了，错的是选之前那次「先按默认开一次」。

### 按住说话「有时没反应，得按久一点」= 松开赶在开麦完成之前

- 症状：按住模式（`voiceCaptureMode: hold`）下按一下热键偶尔毫无反应，按住久一点才录上；热键本身没换、也没被占用。
- 排除顺序（先排除「按不到」再怀疑「录不上」）：`--hold-watch-probe` 里 120 毫秒的轻敲也能产生一按一放，`HOTKEY_HOLD_READY` 也正常，所以按键边沿不是问题；问题在开麦这一侧。
- 根因：`startPcmRecorder()` 每次都要走一次 `getUserMedia`（`openMicStream` 在有偏好设备时会**连开两次**、探测设备时还要再开一次并 `enumerateDevices`），实测几百毫秒到一秒多；而按住说话的一次按下常常只有两三百毫秒——松开（`HOLD 0`）赶在 `recording = true` 之前到达，只能按 `stopWhileStarting` 记一笔，开麦回来时把这段录音**丢掉**（`松开太快，麦克风还没就绪，已忽略`）。用户看到的「按久一点才有反应」其实是「按得比开麦快就白按」。
- 修法：`src/renderer/src/lib/pcm-recorder.ts` 把「开流」和「收音频」拆开——`take()` 取走并清空、`suspend()`/`resume()` 挂起与恢复、`stop()` 仍是一次性关闭（训练页的用法不变）；`src/renderer/src/overlay/voice-capture.ts` 松手后不再关流，而是 `park()` 成一路挂起的麦克风，租约 `MIC_WARM_LEASE_MS`（`src/shared/voice-capture-gate.ts`，两分钟，纯函数 `canReuseMic` 判「租约内且 `readyState === 'live'`」），下一次按下零延迟复用；连「松开太快被丢」那条也改成 `park()`——**丢的是这条录音，不是麦克风**，所以再按一次立刻就有反应。
- 留痕：`VOICE_MIC_OPEN_MS {openMs}`（每次真开流都打，用来判断到底是开麦慢还是别的问题）、`VOICE_MIC_REUSE {ageMs}`（复用命中）、`VOICE_CAPTURE_DROP {reason:'release-before-open', openMs}`（丢了一条）。下次再有人说「热键没反应」，先看这三行，别再猜按键。
- 没做的：不在启动时就常驻开麦（麦克风指示灯一直亮），也不按「对局开始」预热——两种都会让用户在没说话时也占着设备；两分钟租约是折中。

### 听得到游戏吗：环回能开，但快照式识别跟不上（2026-11-21 实测，#127）

- 问题：想让浮层把队友语音转成中文字幕，可 Electron 拿不到「只抓某个进程」的声音，唯一的路是系统级环回（`getDisplayMedia({audio:true})`），队友语音会和音乐、技能音、播报混在一起。这一条先用探针把四个数钉住，再谈做不做。
- 证据入口：`npm run probe -- --interpret-listen-probe`（`src/main/probes/interpret-listen.ts`），产物落 `data/logs/interpret-listen/`：`loopback-<时间>.wav` 是探针自放的 1 kHz 测试音（1.2 秒），`room-<时间>.wav` 是它随后录的 12 秒**机器真实输出**（没人叫它录什么，录的就是此刻在响的东西）。全部 16 kHz 单声道 PCM16，谁都能拿去听。
- 数一：**能开，48 kHz**。`getDisplayMedia({audio:true, video:false})` 一次成功（不需要退回带视频的写法），`AudioContext.sampleRate` 48000、2 声道，`track.getSettings()` 报 48000/1，1.2 秒收到 57344 帧。
- 数二：**轨道里确实是系统声音**。测试音段 RMS 0.095 对沉默段 0.029，1 kHz 与旁带 500 Hz 的功率比 **257.4**（另两次跑分别是 30.0 / 32.4 / 145.4）——探针自己在同一个窗口里放的音，被环回原样抓了回来。
- 数三：**VAD 切得出人话，但静音判断不可靠**。`room-*.wav` 里那段 12 秒是用户真实的对局语音（转出来是「我回家补下蓝，可以出来一起打」「我觉得行」这类），silero VAD 切出 **4 段**、时长 0.48–2.59 秒，都是话的长度。同一套参数喂纯 1 kHz 稳态音（三个文件）：两个切 0 段、一个切出 0.54 秒一段——**稳态音也会偶尔被当成语音**，这是「技能音效误触发」的第一个实证，不能假装没有。
- 数四：**延迟分两种引擎，差两个数量级**（CPU，同一台机器，12 秒素材）：

  | 环节 | 耗时 | 折算 |
  | --- | --- | --- |
  | 环回采样 + 重采样（48k 双声道 → 16k 单声道） | 0 字差异 | 3 句已知录音往返重采样后文本一字不差 |
  | GTCRN 降噪 | 2.0–2.2 秒 / 12 秒音频 | ≈0.18× 实时 |
  | silero VAD 切段 | 0.12–0.18 秒 / 12 秒音频 | ≈0.015× 实时 |
  | paraformer-zh int8（4 线程，段级） | 26–347 毫秒 / 段 | ≈0.03–0.1× 实时，**能跟** |
  | qwen3-asr int8（2 线程，段级） | 1.2–4.3 秒 / 段 | ≈1.1–1.3× 实时，**跟不上** |

  同一段音频 qwen3 整段识别 9.8–10.2 秒（12 秒素材），paraformer 245–853 毫秒。差的是引擎不是链路：qwen3 带标点、句子更整，代价是比实时还慢，做「边说边出字幕」只能选 paraformer（没标点，用 `joinChars` 拼接后再补标点或用翻译侧断句）。
- 结论：**「能不能听到」已答：能，48 kHz 环回可用，降噪 + VAD 能把混音切成话段**。剩下没测的是「混音 vs 麦克风同一个句子的错字率」——那需要一个真人对着麦克风说同一句话，探针的 12 秒环回素材只能证明「话能被切出来并识别成人话」，不能给错误率的分母。这条等有人在局内说话时再补，不要用数字装门面。
- 教训：`about:blank` 上 `navigator.mediaDevices` 根本不存在（不透明来源），探针窗口必须 `loadFile` 到 `overlay.html` 这种可信来源，否则第一句就是 `Cannot read properties of undefined (reading 'getDisplayMedia')`。sherpa 的 `vad.pop()` **只弹出不返回**，取内容要先 `vad.front()` 再 `pop()`，写成 `pop().start` 会 `TypeError`。

### 半双工守卫只守住了主进程那条腿（#129 被测试退回）

**症状**：公告（播报别人的话）期间把自己的声音又识别了一遍 —— 复读；而且「今晚丢了几段」查不到，`VOICE_DROP` 只进了 console。

**根因**：`notePlayback()` 只有主进程 `voice-out.ts` 两个调用点；公告腿在**渲染层**播（`overlay/speech.ts` 自己 `new Audio`），同传回放（`overlay/interpret-echo.ts`）也是。没有任何「这段开始播」的回报，于是 `playingUntil` 一直是 null，守卫永远判「不在播」。探针自己调 `notePlayback()`，所以缺生产调用点时一条断言都不会红 —— 探针钉的是缝，不是调用点。

**修法**：新增 `voice:playback`（`send`，渲染层起播时回报时长）与 `voice:half-duplex`（invoke，读记账快照）；`speech.ts` 与 `interpret-echo.ts` 在 `onplaying` 里回报实际时长；丢弃时除 console 还写一行 `kind: 'half-duplex-drop'` 到 `logs/voice-chain.jsonl`；面板「关于 → 诊断」加一行「自己说话时的回声」（丢过几段 / 没丢过）。

**探针**：`--half-duplex-probe` 增 4 条走**真入口**的断言 —— 播放期调 `transcribeForVoice()` 必须被挡住、计入总数、`voice-chain.jsonl` 里有一行带 `dropped`/`total`。教训：缝上的断言全绿不代表调用点接上了，关键路径至少有一条要穿过生产入口。

### 短句/长句分流一开，每句话都卡两三秒（#142）

- 症状：打开「短句/长句分流」之后，对讲每说一句就顿一下，短句说完要等好几秒才有声音。面板上只写着「一句话会慢一点」。
- 根因：分流是**逐句**决定目标的（`src/main/services/voice/asr-model.ts:243` 每段按 `wavDurationMs` 和 3000 ms 阈值判），而 worker 以前只有**一个**识别器槽（`resources/asr-sherpa-worker.cjs`，键 `kind|dir|hotwords`）。一句话短、下一句长，就等于让 worker 把图拆了重建一次。实测：本机同一段 16 kHz 音频，paraformer 首次 1939 ms、再问一次 90 ms，切到 qwen3 **13228/15352 ms**，切回 paraformer **6530 ms**。这正好落在「说完等回答」的那一刻，用户感到的是卡，不是「慢一点」。
- 修法：worker 改成留**两份**图（`MAX_RECOGNIZERS = 2` + `Map` 按 LRU 淘汰），换引擎变成挪指针。实测切回 paraformer **142 ms**（改前 6530 ms），再切 qwen3 1267 ms（纯推理）。上限设 2 而不是无限，是因为热词串也在键里——反复改热词会不断生成新图，不设上限就把内存吃满；淘汰顺序按最近使用，刚命中的那个不会被挤掉（`ASR_SHERPA_LOAD/HIT/EVICT` 三行日志能看出顺序）。
- 代价与口径：两块 int8 模型同时常驻内存，这是换速度要付的钱；票面另两个选项（给规则加粘滞、或只改文案保持默认关）没做——分流的两台引擎本来就都会被用到，留两图才是根上的解法。文案同步改了实话：`asr-routing.ts` 与 `settings-shape.ts` 原本写「每次换引擎要重载识别器」，现在写「两台各自只加载一次，之后换引擎只是换个指针」。
- 验收：`--asr-switch-probe`（**不进 CI**，要本机装齐两台模型，缺件时 SKIP 并写明缺谁）跑真 worker：同引擎第二次命中、换引擎各加载一次、来回切不再重建、第三个键挤掉最久没用到的那个、挤掉后仍能答。墙钟数字只进 JSON 不当门槛（并发跑必抖）。

## 不想听某个人念（#93）

### 症状

队友一直在语音里刷屏，朗读跟着念一整局；想关掉只能连所有人的朗读一起关（`ttsReadAloud`），
或者关掉「自己也念」。逐个静音没有入口。

### 根因

朗读跳过只有两条判据：全局开关，与 `own`（自己说的话）。身份信息其实已经到手——
`CaptureEntry.speaker` 是 GSI 给的英雄短名，`original` 的展示串里带着 `[昵称]`/`[座位]` 段——
只是没有人拿它做过滤。

### 修法

判据落在 `src/shared/speak-mute.ts`：`identityOf()` 从条目取「英雄短名 + 昵称/座位名」两路身份，
`muteTableOf()` 把设置里的两份名单归一（小写、去空、去重），`isMuted()` 命中任一路即静音。
说话链路上，`speakSkipReason()` 新增跳过原因 `muted-player`（不是全局 `mute`，日志里能分清
「这个人被关了」和「朗读整个关了」）。

设置新增 `ttsMuteHeroes` / `ttsMuteNames`；面板只在「说给谁听」组**加了一行**输入框
（逗号/顿号分隔，失焦即保存，两路都写同一个列表——一个词可能既是昵称又是英雄短名）。

两条纪律：解析不到昵称时**不静音**（否则一个格式变化会把某个人永久关掉）；`own` 行不参与逐人
过滤（自己念不念由「自己也念」决定，否则两个开关会互相打脸）。

## 切段策略：按标点还是按字数（#85）

### 症状

同一句译文，有人说「第一句半天不响」，有人说「听着像被切断的机器人在念」——其实调的是同一个
旋钮：Edge 每段都要一次跨境往返，段切得少就是等、切得碎就是断。改动前只有「每段最多几个字」，
没有「在哪切」的选择。

### 根因

切段函数 `splitForSpeech()` 写在 `src/main/services/voice/speech-pipeline.ts` 里，只会在标点处
切；面板想预览「现在这句会切成几段」，只能自己再写一遍逻辑——两份实现迟早不一致，预览就会撒谎。

### 修法

判据搬到 `src/shared/speech-split.ts`（`splitForSpeech(text, maxChars, strategy)`、`previewSplit()`、
`splitPreviewLine()`、`SPEECH_SPLIT_LABELS/HINTS`、`SEGMENT_CHARS_MIN/MAX/DEFAULT` = 10/60/30）：

- `punctuation`（默认）与改动前逐字等价：标点跟着前一段走，超长段再硬切；
- `uniform` 忽略标点按固定字数切，段长整齐、起播更可预测，代价是可能断在词中间；
- 两条策略都遵守「切完拼回来与原文逐字相同」，探针逐条断言（丢一个标点就是另一句话）。

设置新增 `speechSplitStrategy`；三条出声腿（朗读 `speech.ts`、声出 `voice-out.ts`、对局播报
`announce.ts`）都把它与 `ttsSpeakSegmentChars` 一起传进管线。面板只在「说给谁听」组**加了一行**
（下拉 + hint 用 `splitPreviewLine(SPLIT_SAMPLE…)` 现场试切），不重排。

### 边界

面板预览与真实切法共用同一个函数（探针钉「逐段相同」）；`offline`/`system` 引擎永远整句一段，
策略对它们无效——这一点写在 `ENGINE_DRIVERS` 里，不靠文档口头约定。

## 影子模式：第一局先记账、不出声（#80）

### 症状

新用户第一次装好，一进对局就听见游戏里冒出合成音（或者什么都没听见），既不知道这是
「正常该有的样子」还是「哪里坏了」；等发现声出链有一环没配好，已经过了那一局。

### 根因

声出链（合成 → 虚拟声卡 → 按住说话键）只要有一环不对，表现都是「声音不对」，而这一步
是不可回放的：第一局的第一次出声只有一次机会，用户没有对照物。

### 修法

`src/shared/shadow-voice.ts` 三个状态：`off`（设置里关掉）/ `active`（开着且还没打完过任何
一局）/ `done`（打过一局，自动结束，不靠人记得回来关）。`shadowVoicePath()` 落在
`logs/shadow-voice.jsonl`（256 KB 封顶），每行 `{at, matchid, text}`；`noteShadowLine()`
是唯一写入口，`shadowViewNow()` 把状态、报告、那句面板文案一起交出去（三者同源）。

`src/main/services/voice/voice-out.ts` 的 `speakReply()` 与 `interpretSpeak()` 在**排队与合成之前**
就返回：影子期间不合成、不按键、不灌话筒——不是「音量调小」，是那段代码根本不跑。
「打完过一局没有」按 `logs/gsi-summary/<matchid>.json` 的份数判断，重启后仍然有效。

面板只在「说给谁听」组**加了一行**显示（`影子模式` + `StatusPill` + 那句话），形态不动。

### 边界

影子只拦声出，翻译、纠错、记账照旧；热词与训练数据不受影响。`?shadow=done|off` 是预览桩的
三个画面开关。探针 `--shadow-voice-probe`（ci）20 条断言覆盖三态、拦不拦、报告口径
（最近时间取最大值而不是数组末尾）、三态文案互不相同、落盘路径就是 `logsDir()`。

## ASR 微调（Qwen3）

### G15 试点：底模 13/20 → 微调 19/20
- 数据：G15 组 20 句（16k mono wav，2–3 秒/条），18 句训练 + 尾部 2 句验证，JSONL 用官方格式（`{"audio": ..., "text": "language Chinese<asr_text>句子"}`）。
- 训练：官方 `qwen3_asr_sft.py`，RTX 4070S 上 36.5 分钟（batch 1 × grad_acc 4，lr 2e-5，66 epoch）。train_loss 掉到 0.0001 只是背熟句子，eval_loss 因验证集太小没有参考价值——**效果以真机 A/B 为准**。
- 导出：`export_qwen3_asr_onnx.py` 出 fp32+int8（CPU 可跑），verify max_diff < 0.0001。
- A/B 全量（每模型一个常驻 worker 进程喂 20 句）：微调 19/20 vs 底模 13/20，耗时持平。底模六类错（高地塔→高祭塔、符点→浮点、野怪→也怪、有眼→有野、绕后→路后、偷→头）全修；残余「肉山盾」→「六山盾」一处。

### 换模的两个坑
- sherpa worker 是常驻进程，启动时就把模型文件读进内存——**换文件不杀 worker 等于白换**。`resetSherpaWorker()` 先杀再让下句识别重新拉起。
- 导出产物不带 tokenizer，但 sherpa 启动必须要 `tokenizer_config.json` + `vocab.json` + `merges.txt` 三件。词表没变（训练只动 encoder/decoder），从备份或出厂包借是安全的；`ensureTokenizerFiles()` 已固化这条借用链（曾只兜底 config，结果转正后缺 vocab/merges 静默装不回）。

### 一键环境安装器的镜像清单（2026-11-07 实测换源）
- uv wheel：阿里云 `mirrors.aliyun.com/pypi/simple/uv/`——npmmirror 的 uv 镜像已下线（404）；wheel 把 uv.exe 埋在 `uv-<版本>.data/scripts/`，解压后要往上层挖出来。
- PyPI 包与 torch cu121 wheel：阿里云 `mirrors.aliyun.com/pypi`——清华 simple 403、南大 pytorch-wheels 404、pythonhosted 直连超时，四个源全测过才定它。
- python 解释器：npmmirror python-build-standalone；底模 `Qwen/Qwen3-ASR-0.6B`：hf-mirror.com，huggingface-hub `snapshot_download` 自带断点续传。
- 全部版本冻结自试点实测组合（`ASR_FT_PIP_SPEC`），别随手升级 torch/transformers——官方脚本对版本敏感。
- 教训一：uv 版本号不能按字符串排序挑「最新」，`0.10.2` 会输给 `0.9.5`——按段转数值比较（探针抓过一次）。教训二：国内镜像会悄悄失效，装失败先 curl 一下索引本身再怀疑代码。
- 环境布局：`data/asr-ft-env/{venv,sft,export,models}/`；缺 `venv/Scripts/python.exe` 或底模时 `deriveAsrFtEnvGaps` 点名拒启。

### G14 全链实测与四个坑（2026-11-07，RTX 4060 8G）
- 实测：40 句（38 训 + 2 验）660 步 1:05:18（尾段 3.4 s/it，全程均 5.9 s/步），显存峰值 7661/8188 MiB 只剩 296 MiB——GV 推理必须先让路；train_loss 0.0305。换模（3 次重命名 + tokenizer 借用 + worker 重启）秒级。
- **中文路径导出炸**：decoder 的 fp32 中间产物 >2 GB 时 torch 走 external-data 分片写入，Windows 上用窄字符路径开文件——run 目录名带中文（曾拿数据集名当目录名「地图」）报 `Could not open file or directory: <dir>/thinker.model.embed_tokens.weight`；encoder 701 MB 走另一条路反而能过，看起来像「随机失败」。修法：run/导出目录名固定 ASCII `ft-<时间戳>`。
- **备料附件丢失秒退**：`TrainManager.start()` 原来只把 kind/dataset 传给 `deriveTrainPlan`，丢掉备料挂上的 `asrFt`/`gvResolved` 附件 → 必报「环境没就绪」，且发生在写日志之前，现场全丢。修法：整份 request 透传 + `appendTrainLog()` 把训练状态机落盘 `logs/train.log`（4 MB 滚动）。
- **续训 max_steps 陷阱**：HF Trainer 拿 `--resume_from` 恢复 global_step 后，若本轮 `--epochs` 折算的 max_steps ≤ 已到步数，**整轮跳过不训练直接退场**（一行 `epoch` 都不跑）。续训轮数必须保证总步数 > 上次 checkpoint（应用按「上次步数 + 200」重算）。
- **账本与续训对账**：每次开跑把逐条 key+bytes+mtimeMs 指纹写进 `train/runs.db` 的 `dataset_entries`（外加 run 目录里的 `run.json`）；开训前逐条对账，重录/删除过就**拒启动并点名**（#63 起：增量模式拒绝并把原因给到面板，绝不静默落回全新训练——旧文案「静默新开」已不成立）；「应用新模型」按 exportDir 对上回写 applied——账本只前进不回退，缺文件静默跳过，记账不能反过来挡训练。
### 显存门槛从「拒绝开训」降成「先提醒」（2026-11-21）
- 症状：8G 卡（RTX 4060，8188 MiB）上点「开始训练」被一句「显存不足」直接挡住，可同一台机器上换一轮参数其实能跑完；关掉 GV 推理、关掉浏览器也还是不让开。
- 根因：门槛是硬判——`judgeFtVram()` 用 `freeMiB >= FT_TRAIN_NEED_MIB`（6400 MiB）决定能不能开训。但这台机器上实测：失败时刻整卡已用 6724 MiB，把 GPT-SoVITS 停掉之后仍占着 4019 MiB（别的进程），「关程序凑够 6.4G」根本凑不到。硬拦的后果是把本来能跑的训练永久挡在门外，而且用户没有任何办法去满足它。
- 修法：判断保留、后果降级。`judgeFtVram()` 照旧返回 `{ok, freeMiB, holders}`（`holders` 只收占用 ≥200 MiB 的进程，用来点名是谁占着），`ftVramNote()` 把它翻成一句人话提示：够用返回 `null`，不够返回「显存偏紧：整卡已用 X / Y MiB，可空出约 Z MiB（训练建议 6400 MiB）…照常开跑；真不够会在训练里报 CUDA OOM，那时关掉占卡程序再点一次。」`ftVramGuard()`（主进程，`nvidia-smi --query-gpu=memory.total,memory.used` + `--query-compute-apps`）把提示塞进 `resolveAsrFtTrainRequest()` 的 `warning` 字段，`TrainManager.start()` 把它写成训练日志的第一行——于是它既在开跑前可见，也留在日志里，事后能对上「为什么这次 OOM」。真不够时训练自己的 CUDA OOM 报错才是最终判据。
- 探针钉住四态：够用 `ok`、7000 已用判 `bad`、`ftVramNote` 在 6724 已用且排除自家进程后给出「照常开跑」、够用时返回 `null`（`src/main/probes/train.ts`）。

### 导出腿没写完就转正 = 识别 worker 直接加载失败（2026-11-21）
- 症状：训练跑完、导出腿还在写最后一件时点「应用新模型」，界面说成功，下一句识别直接报加载失败，得手动把备份目录覆盖回去。
- 根因：换模判据只看「导出目录存在吗」，不看里面凑没凑齐 sherpa 要的那几件。导出是逐件落盘的（conv_frontend → encoder → decoder），中途断掉时目录里已经有前两件，`lastExportDir` 也是有效的，于是残缺目录被 `rename` 成了现役。
- 修法：`FT_MODEL_FILES`（= `ftArtifactTargets('qwen3')`，三件 int8 onnx）配上 `missingFtExportFiles(names, engineId)`，在 `applyAsrFtModel()` 里逐件点名，缺任何一件就拒绝转正并说清缺谁：「导出没跑完（缺 encoder.int8.onnx、decoder.int8.onnx）：重新点一次「开始训练」，等导出完成再应用」。注意引擎 id 必须显式传：不传默认按 qwen3 的三件查，拿去查 paraformer 的导出目录会把 `model.int8.onnx` + `tokens.txt` 判成缺件（2026-11-09 实测）。探针三例：齐 → 0 缺；只有 fp32 分片 → 缺两件；空目录 → 缺三件。

### 全新装机第一次「应用新模型」必失败（2026-11-21）
- 症状：干净安装（`asr-models/` 这个目录从来没存在过）上跑完第一轮微调，点「应用新模型」必失败，报「导出产物缺 tokenizer 词表文件，备份和原始模型目录里也没得借」。
- 根因：两件事叠在一起。一是转正时把整个导出目录拷进 `qwen3-asr.next`——导出目录里有 3–5 GB 的 fp32 external-data 分片，拷一次现役目录翻几倍，下一轮换模还要再拷一遍；二是借用链当年只找 `bak` 与 `asr-models/*`，而新装机这两处都没有 qwen3 的词表，用户真正有的那份是「对讲」下载到 `voice-runtime/models/qwen3-asr/` 的官方模型——它根本没在链上。
- 修法：只拷引擎表声明的三件 int8（`finetune.artifacts[].from → to`），词表单独借。兜底链固定成 `[刚备份的上一版, asr-models 下任何目录, shippedModelDir(), 训练底模目录]`，其中 `shippedModelDir()` 就是 `voice-runtime/models/<现役模型名>`——新装机的词表从这里借得到。`tokenizer` 这一项目标是目录、源可能是平铺布局，所以交给 `ensureTokenizerFiles()` 逐件拼（`tokenizer_config.json` / `vocab.json` / `merges.txt` 各找 `src/tokenizer/f` 与 `src/f`），三件齐才算成功，缺一件就抛「导出产物缺 tokenizer 词表文件…」而不是装个坏目录。`paraformer` 的 `tokens.txt` 走同一条 `finetune.borrow` 循环。
## GV 微调（GPT-SoVITS v2pro 包）

### 训练命令真相源（读自上游 webui.py，2026-11-04）
- SoVITS 腿：`<runtime>/python -s GPT_SoVITS/s2_train.py --config <tmp_s2.json>`（webui.py:542，v3/v4 才换 s2_train_v3_lora.py）；GPT 腿：`-s GPT_SoVITS/s1_train.py --config_file <tmp_s1.yaml>`（webui.py:636）；cwd 一律在引擎包根。
- 配置不是命令行参数，是**先写文件再启动**：s2 写 `tmp/tmp_s2.json`（webui open1Ba :485-555 在模板上 patch：epochs/batch_size/pretrained_s2G、s2D 路径/save_weight_dir 等）；s1 写 `tmp/tmp_s1.yaml`（open1Bb :586-645：half_weights_save_dir、`6-name2semantic.tsv`、`2-name2text.txt` 路径等）。应用的 `buildS2TrainConfigData`/`buildS1TrainConfigData`（`src/shared/train.ts`）照抄这两段 patch，模板取包内 `s2{ver}.json` / `s1longer-v2.yaml`。
- 版本→底模/权重目录映射全在包内 `config.py`（v2ProPlus → gsv-v4-pretrained/s1v3.ckpt + v2Pro/s2Gv2ProPlus.pth，权重目录 `*_weights_v2ProPlus`）；应用内 `GV_VERSION_INFO` 与它一一对应，探针钉住六版全表。
- 备料四件套（官方 1-get-text / 2-get-hubert-wav32k / 3-get-semantic 的产物）：`2-name2text.txt`、`4-cnhubert/`、`5-wav32k/`、`6-name2semantic.tsv`——`judgeGvDataset` 按这个验收 `logs/<实验名>/`，齐了数据集下拉才显示「就绪」。切分/标注仍走官方 webui（官方有降噪和试听，应用不重造）。
- 产物注册：两腿各自 `*_weights_v2*` 目录里挑 `<实验名>_` 前缀 mtime 最新的 ckpt/pth 拷进 `data/gpt-sovits/weights/<音色名>/`，参考音频取 `.list` 第一行（丢了从 `5-wav32k/` 兜底），refs.json 按音色名 upsert。
- 坑（读源码证实）：备料脚本解析 wav 时**只按文件名**在 `inp_wav_dir` 平铺目录里找（2-get-hubert-wav32k.py:116-118 剥掉路径再拼），路径不对会被 try/except 静默吞掉——数据集必须平铺、前缀防撞（en_/zh_）。重训同名实验会覆盖包内同名权重，注册时拷走一份正好兼作回滚点。
- 待真机回填：真训练时长与显存（batch 8 在 8G 卡上是否吃得下）、训练日志里 tqdm 的具体形态（`parseTrainProgress` 已按 epoch/tqdm/step/裸百分数四级兜底，真跑一次看命中哪级）。

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

### 只想换 JS 却要重装整个包（`pack-win --swap`）
- 症状：改一行主进程逻辑，验证一次就得跑一遍 NSIS 安装，一两分钟起步，还得关掉正在跑的应用。
- 根因：`pack:win` 走 electron-builder 的 NSIS 目标，它重写整个安装目录；而真正变了的只有 `resources/app.asar` 一个文件（Electron 与原生依赖都没动）。
- 修法：`node scripts/pack-win.mjs --swap` 只做两件事——`electron-builder --dir` 打包到临时目录，然后把其中 `resources/app.asar` 拷进安装目录，动手前把旧的存成 `app.asar.bak`。换完重开应用即生效；回滚就是把 `app.asar.bak` 覆盖回去。整包安装仍然走 `npm run pack:win`。
- 注意：只适用于纯 JS/TS 改动。换了 Electron 版本、增删了原生依赖或改了 `build/installer.nsh`，必须走整包。

### 打包机上的镜像只设一个变量不够（`unable to verify the first certificate`）
- 症状：国内机器上 `npm run pack:win` 报 `unable to verify the first certificate`，或者卡在下载 Electron zip 上直到超时。
- 根因：这里有两个不同的下载者。`electron` 的 postinstall 下 Electron 二进制，认 `ELECTRON_MIRROR`；`electron-builder` 自己还要下 NSIS、winCodeSign 等 builder binaries，认的是 `ELECTRON_BUILDER_BINARIES_MIRROR`。只设后者，前面那步仍然直连 GitHub。
- 修法：两个都设——`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`。脚本里都有默认值，所以清掉这两个变量反而会走默认镜像；真要让脚本不设，得显式传空串。


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

### 多 Steam 库：选了哪个就写哪个，库没了就报缺失（#78）
- 症状：注册表给的那个库没装 Dota、Dota 在移动硬盘或另一个库里时，应用会挑错库写 cfg，用户完全无感——「我明明选了 D 盘却还是写的 C 盘」这类问题最难查。
- 根因：`libraryfolders.vdf` 展开出来的库根不止一个，旧逻辑只取「第一个真装了 Dota 的」，选择是无形的，换盘后还会静默改道。
- 修法：`settings.gsiLibraryRoot` 记住用户选的库根（空 = 自动）。选了就只认那一个——被拔掉或改盘符时报「路径缺失」（`resolveGsiRoot` 的 `missing` 标记 → `ensureGsiConfig` 返回中文 error，面板总览「这台机器」组显示红灯 + 重选下拉），**绝不**悄悄改写到别的库，否则用户永远查不到线索。`setGsiLibrary` 保存前先校验库在枚举结果里且真装了 Dota，存的是一个写不进 cfg 的路径是最难查的一类「我选了啊」。
- 判据：「Dota 只在启动时读 GSI 配置，换库后要重启游戏才会生效」这句提示是行为的一部分，不许改成「已生效」。枚举本身：注册表给的路子里已有人装 Dota 就不再扫盘符（正常启动不为兜底付 26×4 次 stat），`--gsi-probe` 有纯用例断言两个库时选非常用那个、库没了报缺失、非法库被拒。
### 帧停了，应用却像一切正常（GSI 断流只能诊断，不能自愈）
- 症状：游戏里还在打，浮层再没出过新行；`logs/gsi-summary.json` 还留着上一局的数字，看上去「数据都在」。用户的第一反应是「翻译挂了」，实际是推送早断了。
- 根因：Dota 只在启动时读一次 `gamestate_integration/*.cfg`，运行中任何进程内手段都重载不了它——改 cfg、换端口、重启监听服务全都没用。而且心跳超时（90 秒）一到 `live` 就被清掉，光靠实时判定再也算不出「刚才断过」。所以这不是一个能自愈的问题，能做的只有把「谁停了、停了多久、配置对不对」摆到人面前，并告诉人唯一的解法：重启游戏。
- 修法（`src/shared/gsi-stall.ts` 判据 + `gsi.ts` 的 `watchdogTick`）：超过 90 秒没帧、且仍认为在打对局时，按当前端口重写一次 cfg（保证「重启 Dota」真的能连上，而不是连一个旧端口）、往 `logs/gsi-stall.jsonl` 写一行 `GSI_STALL_DIAG`（cfg 路径在不在、端口是不是自己占着、静默多久、有没有重写）、在总览「异常」组挂一条告警；`GsiStatusView.stall` 会一直粘到下一帧到达才清。断流期间也不再去停捕获——`live=false` 之后照常超时收场，用户重启游戏推一帧就自然恢复。
- 判据：文案里**只许出现「重启 Dota」**，任何「已恢复/已重连/已修复」都是假的（`--gsi-probe` 有一条正则断言专门拦这几个词）。另外「一次断流只诊断一次」——`stallHandled` 置位后不再每 10 秒重写一遍 cfg，否则 5 分钟断流会在 Dota 目录里敲二十次文件。
- 教训：心跳超时清掉的 `live` 不能当「当前状态」用。做这种告警，判据必须同时看「现在有没有帧」和「上一次在打是什么时候」，只留一份实时状态就会在关键时刻失忆。探针里也是靠注入时钟（`clock: () => fakeNow`）推快 120 秒，否则这条路径永远没人测。

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
- 只要正文含汉字就不翻译：两条路都先看正文，出现任意一个汉字（`hasHan()`）就认定已经是目标语言，跳过模型直接以「无译文」上屏——只译文模式下没有 `.trans` 层的行会回落到原文，正好就是要显示的样子。中英混排也算（`push 中路 now` 不翻），因为翻过去只会把「中路」再糟蹋一遍。判的是**正文**不是整行：GSI 那行的 `[队友]`/`[敌方]` 自带汉字，拿整行判会把 `lol`、`back off` 这种纯英文误判成中文。2026-11 起 `CaptureEntry.body` 与上屏串 `original` 分开，正文只此一份、不再从行里剥（旧实现靠 `chatBody()`/`splitChatLine()` 把 GSI 自己拼的行拆回来，中文昵称留在正文里就让整句永不翻译）。早期版本用的是「汉字占比 ≥50%」，用户明确要求改成「包含即跳过」。`--chat-block-probe` 固定了这些判据。
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

### allplayers 一帧都没到——别人的英雄名从 GSI 拿不到
- 症状：朗读只剩内容、没有「某某说」；浮层行英雄一栏为空，昵称退回「玩家N」。
- 证据：真对局 9061130332（3499 帧）与同日另一局（796 帧）`allplayersFrames` 都是 0，而盘上 cfg 明确写了 `"allplayers" "1"`（mtime 10-24 02:38，Dota 在其后启动）；同一批帧里 provider/map/player/hero/events 每帧都到。社区口径一致（Dota2GSI issue #4、dota-gsi 库的示例 cfg）：Dota 2 GSI 只推本机玩家的 `player`/`hero`，`allplayers` 是 CS:GO 的块名。
- 结论修正：上文「allplayers 有数据（4210/4812 帧）」是 v1.1.0 时期的历史观测，不能当「真对局一定有」的依据。以前能听到英雄名的其实只有自己的话（hero 块只含自己）；自己的话默认不念之后，英雄名就彻底消失了。
- 修法：`decideSpeak` 拿不到英雄时退回行前缀里的 `[关系]`，念「队友说，/敌方说，」，OCR 行没有关系标签就不加前缀；自己的话（`ttsReadOwn` 打开）仍用 hero 块的英雄名。cfg 保留 `allplayers "1"`：哪天 Valve 又推了，代码本来就接得住（`refreshSlotNames` + `normalizeSlot` 一直在）。
- 教训：观测结论要带日期和客户端版本。「官方不支持」和「这版不支持」在下次升级后可能是相反的答案，但都别替 Valve 乐观。
- 二次实测（2026-10-25 14:17–14:20，match 9061444883，156 帧）：`allplayersFrames` 仍是 0；`blocks` 里只有 provider/map/player/events/hero 每帧都到，`added`/`previously` 分别出现 5/155 帧却一个人名也没带来。**「块出现」不等于「有数据」**——`tallyFrame` 只数键存在，空对象也算，所以判读必须看内容非空的计数（`allplayersFrames` 那一路才是可用的），别被块直方图骗了。同批 `gsi-chat.jsonl` 227 条里只有 6 条带 `hero`，全是有 `own: true` 的那 6 条自己的话。
- 附带真 bug（同日修）：`gsi-config.ts` 有九行 data 块写成了 `'\\t\\t"abilities"\\t"1"'`，落到 cfg 里就是字面反斜杠+t，KeyValues 只看到一串无意义 token——cfg 打开看着齐全，实际上 `abilities/items/draft/buildings/minimap/roshan/couriers/previously/added` 一个都没请求。改成真 tab，并让 `--gsi-probe` 断言 cfg 形状（每个键都要 `\t\t"键"\t`、全文不许出现反斜杠），因为这种坏法肉眼读 cfg 看不出来。cfg 只在 Dota 启动时读，改完必须重启游戏才生效。
- 他人英雄名调查终局（2026-10-25 正式天梯 9061521387 验证）：`draft` 块在 Ranked All Pick 的**选人阶段也不推内容**——应用全程在线、`recordDraft()` 记录器（`gsi.ts`，非空才落 `data/logs/gsi-draft.jsonl`）零输出。四条路全部死亡：allplayers（0 帧×4 局）、minimap（元素 `oN` 键只带 unitname/team，`name` 是英雄名重复，无槽位）、draft（选人空）、hero/player 的 `.Teams` 层（仅观战）。结论盖棺：**正式对局端他人英雄名在 GSI 无数据源**，「队友说/敌方说」是永久形态。记录器保留——打 CM/队长模式那天 `gsi-draft.jsonl` 会自动出证据。
- 翻案线索（同日晚，dotabod 源码）：GSI 四路死亡 ≠ 别人英雄名拿不到。dotabod 的聊天翻译确实给每个说话人标英雄名，但 roster 来自 resolver 链（`packages/dota/src/dota/lib/matchData/resolvers/`）：SourceTV（连 GOTV 的 writer / 按需 **Steam Web API `GetRealTimeStats`**）→ 自家 CV 服务（看直播认 10 个头像，460 槽 45/46 准，用 GSI 自身英雄纠错）→ GSI-self 兜底（只有自己，即我们的现状）。要做「别人也念英雄名」，可行路线是 `GetRealTimeStats`（需要 server_steam_id：`server_log.txt` 的 `[A:1:xxx:yyy]` 行 + lobby 行按 slot 列 10 个 steamid，Dota 启动项加 `-condebug`）或 CV 识别记分板。详见 wiki `dotabod-roster-not-from-gsi`。
- cfg 块清单的权威来源（2026-10-25 定）：antonpup/Dota2GSI 的 README 里 `GenerateGSIConfigFile` 生成的模板——
  https://raw.githubusercontent.com/antonpup/Dota2GSI/master/README.md （GitHub 需代理）。模板开 15 块：
  `auth/provider/map/player/hero/abilities/items/events/buildings/league/draft/wearables/minimap/roshan/couriers/neutralitems`
  （数下来 16 项，auth 算 payload 回显不算数据块；我们额外保留 `allplayers/previously/added`）。据此补齐了
  `auth/league/wearables/neutralitems` 四块，cfg 一次开全 19 项：Dota 忽略不认识的键，以后要用新块时
  不必再改 cfg、再求用户重启游戏。以后「还有哪个块没开」这类问题先对着这份模板核，别凭记忆。
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

- 症状：账本里攒下 `???`、`。。。`、`666`、`g` 这类一对，`hits` 还挺高（队友一直刷）。
- 根因：过滤只判了 `hasHan`（已经是中文就不翻），没人管「根本没有可翻的文字」。真实对局里 83 条独立正文中，纯符号（`???`）与长度 1（`啥`、`g`、`?`）是仅有的两类噪声，但它们每一句都要占一次模型请求。
- 修法：`worthTranslating(body)` 与 `hasHan` 分工——`hasHan` 判「已是目标语言」，`worthTranslating` 判「没有可翻的文字」：既没有字母也没有汉字（纯符号/纯数字/纯 emoji）、或去掉空白后只剩一个码点，都不进队列。两条入口用同一把尺子：OCR 的 `buildEntries` 与 GSI 的 `pushMessages`，否则 GSI 路线会漏过滤。

### 模型把原文原样吐回来时，那不是译文

- 症状：`gg → gg`，浮层把同一句显示两遍；账本多一条 `a` 与 `b` 内容相同的一对。
- 根因：`translateLines` 无条件把模型返回写进账本。
- 修法：`sameText(a, b)` 归一化后比较（小写 + 去空白/标点/符号，`??? go` 与 `???  go!` 算同一句），相同就不记、也不当译文（这条行显示为「没有译文」）。注意它只处理「字面相同」；`gg wp` 这类缩写模型可能补全，那就照常记账。

### GSI 有明确的局末信号，就不该再靠「整屏换掉」猜

- 症状：第二局开头浮层还挂着上一局的话；OCR 侧的去重窗口也没清，新局开局同一句 `gl hf` 会被当重复丢掉。
- 根因：`resetSession()` 只有 OCR tick 里的「连续几拍完全不重叠」那一支会调；GSI 路线拿到 `POST_GAME` 时只停了捕获，没清屏。
- 修法：`endMatchSession()` 一个公开方法（清去重窗口 + 广播空 `CAPTURE_REPLACE`），由 GSI 的 `stopCapture` 在局末调用。OCR 那边的换局判定保留——它是猜，但猜得动；GSI 不需要猜。

### 「还在翻」和「已经废了」长得一模一样

- 症状：模型服务不可达（或 Key 失效）时，浮层那一行永远停在「未翻译」，既没有报错也没有超时提示。看的人无从判断是网络慢还是彻底断了。
- 根因：`translatePending` 只有一条 `catch` 写 `lastError`，而 `lastError` 只进面板；浮层的行对象里根本没有「失败」这个状态——`translated: null` 同时表示「还没翻」和「翻不成」。
- 修法：`CaptureEntry.error` 显式区分。`buildEntries` 只给**真的进了队列**的行标错（用 `attempted` 集合），中文行与不值得翻的行不背锅；浮层画 `.trans.err`（`✕ 翻译失败`，`title` 挂原始报错），面板同理。探针 `--overlay-probe` 用一条假失败行断言 `errorOk`——这条不做断言的话，回归时没人会发现浮层又开始沉默。

### 英译中吐回英文原文 = 保真守卫把好译文扔了

- 症状：面板「翻译引擎 → 试验台」的「队友发言 → 中文」输入 `careful mid, they smoke rosh`，点翻译，框里回来的还是这句英文，看起来像语言/方向弄错了。
- 根因：不是方向错，也不是模型没翻。同一句直接问豆包返回的是 `小心中路，他们开雾打肉山`——译对了。是 `src/shared/translate-fidelity.ts` 的保真守卫判它违例：en-zh 当时要求源文里的保真词（`rosh`/`smoke`/`mid`…）必须在译文里原样留着，而中文输出当然是 `肉山`/`开雾`/`中路`。守卫重试一次还是同一个中文译法，第二次违例就「放弃并回原文」，面板于是把源文当译文显示；真实链路里同样的结果会被当成「译文 === 原文」静默丢掉，也就是那句队友发言彻底不翻。
- 修法：en-zh / auto-zh 只有在**译文还是纯拉丁**（模型复读源文或抄错缩写 `bkb→bkg`）时才要求保真词在场；译文含汉字就说明真的译成了中文，不再拿拉丁 token 做包含判定。zh-en 方向不变（中文源里的每个拉丁 token 和数字仍必须出现）。`--translate-accuracy-probe` 里那两条把旧行为当契约的断言（`bkb is ready → 黑皇杖好了` 算违例、`gg → 干得漂亮` 算违例）同步改成新契约，并加了一条钉住这次的原始案例。


## 告警旁边要有一句「看这台机器」

- 症状：GV 出声链路断了，告警出现在「浮层与对局」页，用户知道出事了，却不知道去哪看 CPU / 内存 / 磁盘 / 端口 / 设备这些真正能定位的数字——得自己想到去总览翻六行。
- 根因：告警与体检长在两个地方，中间没有路。早先只在总览立了「这台机器」，等于把地图给了却没告诉人从哪进。
- 修法：`src/shared/env-report.ts` 的 `machineCheckOffer(warnings)` 决定这入口出不出现（只在真有告警时出现）；`talk.tsx` 的 GV 就绪行在 `ready === false` 时多一个「看这台机器」按钮，`panel-app.tsx` 的 `openMachineCheck()` 走现成的 `select('overview')` + `?s=` 深链，切完一帧后把 `#machine-check` 滚进视野（总览懒渲染，切完当帧还没有节点，所以 `setTimeout(60)`，找不到也不报错）。
- 纪律：**全绿时不留这个按钮**。一个点进去看不出任何东西的按钮，比没有入口更糟——人会以为它修好了什么。文案只由 `MACHINE_CHECK_LABEL` 一处定义，三处告警要加就调同一个缝。
- 验收：`check:pure` 四条（无告警不出现、任一告警出现、文案单点、hint 说清原因）；预览 `?s=talk&warn=1&outEngine=sovits` 出现按钮、点它落到 `?s=overview` 且 `#machine-check` 在视口内（实测 `top 153 / bottom 618 / viewport 720`），`?s=talk&outEngine=sovits` 没有该按钮。

## 译文抽检（对局里标「这句译得好/差」）

- 症状：换个供应商之后没人说得清「到底哪家译得好」，只能凭印象；想攒证据时又得手动复制原文与译文。
- 根因：纠错回路只覆盖 ASR（`src/main/services/voice/corrections.ts`），译文质量没有任何留痕；听感是唯一的判据，而听感过一夜就忘。
- 修法：两个热键（`markGood` 默认 `Alt+Shift+M`、`markBad` 默认 `Alt+Shift+N`）标「浮层上最后一条已翻译的行」，写 `logs/translation-marks.jsonl`：原文、译文、判定、`matchid`（`liveMatchId()`，拿不到写 `null` 并单独计数）、当时的 provider/model、是否记账本直给（`cached`）。`src/shared/translation-mark.ts` 是唯一口径：没翻出来的行不记（空样本会把好评率算假）、同一行改判只留最后一条（按 `entryId` 去重）、统计按（供应商 × 模型）分组、`newest` 取真实最大时间。面板「关于 → 诊断 → 译文抽检」读一句话汇总，明细看 jsonl。
- 纪律：热键不许静默——没有可标记的行也要 flash 一句「没有可标记的译文」；统计里 0 条说的是「还没标过」，不是「全部译得对」；记的是**被标记过**的样本，不能拿它当全量准确率。
- 验收：`--translation-mark-probe`（ci）12 条；其中「同一行改判只留最后一条」「空样本被拒」「标不上时反馈说清原因」是回归线。

## 接着外接屏摆好的浮层，拔掉屏就白摆了（#101）

- 症状：笔记本接着外接屏时把浮层拖到副屏角落摆好；拔掉外接屏回主屏，浮层回到主屏默认位置；再插上外接屏，还是默认位置——摆过的位置没了。反过来把副屏拔掉但记忆还指着副屏坐标时，窗口会停在主屏可见区之外，看起来就是「浮层不见了」。
- 根因：`settings.overlayBounds` 只有一份几何。第二块屏幕上的坐标被记下来以后，没有「哪块屏幕」这个概念，回主屏时那份坐标要么被夹回主屏（信息丢了），要么留在屏幕外（窗口找不回来）。
- 修法：设置里改成 `overlayBoundsByDisplay`（屏幕 id → 几何，最多 8 块，超了丢最早记的）。纯缝 `src/shared/display-geometry.ts` 一处判：`planBounds()` 查这一刻该用哪份——记的屏幕还在就夹进它的工作区（`landed: 'remembered'`）；记的屏幕不在了就用主屏，并且 `fitInside()` 把位置与尺寸**整块**装进去（`landed: 'primary'`）。`overlay.ts` 只在 `persist()` 里做「这一屏的几何 → 分屏表」的翻译（状态机 `reduceOverlay` 不认识屏幕 id，`OverlayPersistPatch.overlayBounds` 是虚拟键），并在窗口创建时挂 `display-added/removed/metrics-changed` 三个监听，屏幕一变就重算并 `reposition()`。
- 为什么整块而不是留抓手：`clampGeometry` 的 `KEEP_VISIBLE_PX = 80` 是给「用户自己把窗口拖出屏幕」用的——那时人知道自己在做什么，留个抓手够抓回来。而「记的屏幕没了」是系统事件，人没做错任何事，给他一个半截露头的窗口等于让他再找一次。
- 旧数据：老文件里那份唯一的 `overlayBounds` 在读入时搬进新表，键用 `LEGACY_BOUNDS_KEY = 'previous'`——那个键永远对应不到真实屏幕，于是自然走「屏幕不在了 → 整块落回主屏」那条路，不需要额外写一段迁移逻辑；搬完把死字段删掉，否则下次落盘又写回去。
- 验收：`--overlay-geometry-probe` 62 条里新增 8 条（两块屏各记各的、各回各屏、拔掉副屏整块回主屏可见区、副屏更大时尺寸一起压、旧键按屏幕不在了处理、上限先丢最早、还原只忘当前屏、三种情况三句话）。

## 浮层几何

### 锁定、拖动、缩放、还原各自该治什么

症状（期望而不是事故）：浮层固定贴在捕获区域旁边，位置和宽度都不能改。想让它在左边一点、或者窄一点少挡画面，只能改捕获区域；而捕获区域又是随手框的，于是每次都要重新框一次。

- 根因：窗口位置写死在 `reposition()` 里（跟着 `region` 算 x/y/h），宽度是常量 `OVERLAY_WIDTH = 340`，`resizable: false`，也没有任何持久化字段。也就是说「几何」从来不是用户的东西。

修法，四条语义分开：
- **锁定**（`overlayLocked`，默认开）= 位置尺寸冻住 **且强制点击穿透**。默认锁着很重要：不锁就等于让一个能挡住鼠标的窗口飘在游戏上。
- **解锁**才出现工具条与两侧把手；拖动/拉伸在渲染进程算增量，`applyGeometry` 在主进程统一 `clampGeometry`。边界只在主进程收口，因为渲染进程拿不到显示器工作区。
- **还原**（`overlayBounds = null`）回到「跟随捕获区域」的默认摆放。这条和「记住位置」是配套的：正因为记住了才不会每次开机都跳回去，也正因为记住了才更需要一个一键回到默认的出口。
- 左右两个把手的不变式不同：拉右边只改 `width`、`x` 不动；拉左边**右边缘钉死**（`x` 与 `width` 反向变化）。写反了的表现是「一拖窗口就跳一下」，肉眼很难归因。

`--overlay-geometry-probe` 把这六条不变式钉成 9 个纯算术用例（另含贴边时宽度下限优先）。这类错误只在别人的屏幕尺寸上复现，靠手感发现概率太低。

## 全局热键

### 界面上的键名比代码活得更久

- 症状：面板底部一行小字长期写着 `Alt+Shift+R 框选区域`、`Alt+Shift+Y 回复`，浮层提示写着 `Alt+Shift+C`；按这些键什么都不会发生。这三个键从来没注册过（或者注册它们的代码早删了），却在大半年里持续被推荐给用户。
- 根因：键名是**字符串字面量**，散在渲染层、提示文案和文档里；而注册代码是另一处。删掉一个功能时，注册那一行跟着功能一起删，字面量却留在没人会顺手打开的文件里。两处没有任何编译期联系，所以编译器不会提醒。
- 修法：键名只有一个来源——动作表 `HOTKEY_ACTIONS`（`src/shared/hotkeys.ts`）。谁要显示键，就读表；跨进程显示（浮层没有设置访问权）就随状态载荷下发（`OverlayStatus.hotkeys`、`captureHint({ toggleKey })`）。`--hotkey-probe` 钉住归一化与冲突规则。
- 教训：任何「给用户看的、由配置决定的名字」都不许写字面量。写一次看着省事，代价是功能删了六个月之后还有人照它按键。判据也很简单：`grep -rn 'Alt+Shift' src/renderer/` 应该是 0 条。

### 注册失败看起来和成功一模一样

- 症状：用户改了键，按下去毫无反应，日志里也没有任何东西，因为根本没人去看日志。
- 根因：`globalShortcut.register()` 抢不到键只返回 `false`，它不会抛错。旧代码把 `false` 变成一行 `console.log`，于是「被输入法/OBS/剪辑工具占用」和「正常工作」在用户眼里完全不可区分——都是「按了没反应」或「能按」二选一里的前者，且无法自救。
- 修法：把结局变成数据。`applyHotkeys()` 返回 `accepted | rejected | unbound` 逐动作带回面板，行上直接徽章显示「被占用」，用户自己就能换键；「两个动作撞同一个键」则在**保存前**整表拒收（`findHotkeyConflicts`），不让先注册的那个静默赢。
- 教训：一个只在日志里的失败，等于没有失败信号。凡是用户能触发、又能自愈的失败，结局必须回到用户眼前。


### 按住说话「松开不停录、按住没反应」：竞态在录音腿，不在热键监视

- 症状：按住模式（`voiceCaptureMode=hold`）时好时坏——松开之后录音不结束，要再按一下才停；卡住的这段时间里再按住毫无反应。
- 根因：`overlay/voice-capture.ts` 的 `recording` 要等 `getUserMedia` 开麦完成才置 true（几十到几百毫秒，设备探测/切换时更久），而 `stop()` 开头 `if (!recording) return` 把这段窗口里到达的松开信号**静默丢弃**。丢弃之后录音最长挂 20 秒（RECORD_MAX_MS 才自动停），期间 `start()` 又因 `recording=true` 直接跳过——「再按一下」恰好是唯一能结束它的操作，两个症状同源。
- 修法：开麦未落定时按下/松开不丢，记为意图（`starting` / `stopWhileStarting`），落定时按最后一条结算：松开先到就立刻收掉流并提示「松开太快」；落定前又按下则撤销挂起的停（重按重试）。开麦另加 3 秒超时（`MIC_OPEN_TIMEOUT_MS`，getUserMedia 挂死一次热键就永久哑掉；判负后才开成的流立刻关掉）；设备名探查挪到 `recording=true` 之后异步补齐，不再撑大竞态窗口。
- 教训：事件驱动的状态机里，「条件不满足就 return」的守卫会把快速边沿变成静默丢失。边沿必须记账、落定时结算，不能当场丢弃——丢一条边，用户看到的就是「按键时灵时不灵」。
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
- 修法：防护跟随「能不能操作」而不是跟随锁定——锁定且呼出面板没开时挡截图，解锁或面板打开都让开。判据在 `shouldProtectContent(locked, panelOpen)`。
- 2026-11 追加：之前只判锁定，于是「锁定状态下按 Alt+Shift+H 唤出面板」既挡截图又丢鼠标消息，看着像面板坏了。现在面板一开就解除防护。
- 顺带：外部截图工具（含我自己的桌面截图）看不到浮层，就是这条在起作用；排查「浮层在哪」时别拿截图当证据。

### 浮层被游戏画面盖住 = 游戏跑在独占全屏
- 症状：浮层明明「已显示」，游戏里却只能看见它一小会儿或完全看不见，Alt+Shift+O 反复按也没用。
- 根因：独占全屏是 DXGI 的独占交换链，**任何窗口都画不到它上面**——不是置顶标志写错了，`setAlwaysOnTop(true, 'screen-saver')` 再怎么重申也没用。取证方法：读游戏自己写的 `<steam>/userdata/<账号>/570/local/cfg/video.txt`，`"setting.fullscreen" "1"` 就是独占全屏（2026-11-14 实测用户机器正是这个值）。
- 修法：产品侧不能修，只能**说出来**。`src/shared/dota-video.ts` 把 `video.txt` 认成 `exclusive | borderless | windowed` 并给一句「在 Dota 2 里把显示模式改成『全屏窗口』」，面板「浮层 → Dota 2 显示模式」显示模式名 + 警告；`--dota-display-probe` 一条命令读当前值。全屏窗口（`fullscreen 0` + `nowindowborder 1`）仍是普通窗口，置顶浮层正常工作。
- 注意：`nowindowborder` 只在窗口化时生效，`fullscreen = 1` 时它不影响结论——两个字段别混着判。

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

### 呼出面板关不掉：文案写着 Esc，代码里没人监听
- 症状：按 Alt+Shift+H 唤出面板后，Esc 按了没反应，只能用鼠标点「关闭（Esc）」，或再按一次热键。
- 根因：按钮文案（`src/renderer/src/overlay/summon-panel.tsx`）与 `GLOSSARY.md` 都写着 Esc 能关，但渲染层只有方向键/Enter 的监听，全仓库没有一处处理 `Escape`。
- 修法：`SummonPanel` 自己挂 `keydown`，命中 `Escape` 就调 `overlayPanelToggle()`，状态与穿透恢复交给主进程 `togglePanel`（它本来就这么做）。
- 教训：按钮上写了快捷键，就等于对外承诺了这条路径；文案和监听必须同一个提交里出现。

### 锁定后鼠标划过浮层还会亮 = forward 把移动消息喂给了页面
- 症状：浮层锁定（默认态）之后，指针划过去行还会亮、光标还会变，看着像「锁定没生效」。
- 根因：`setIgnoreMouseEvents(true, { forward: true })`。`forward` 只会把鼠标**移动**消息转发给页面（Electron 类型文档 `IgnoreMouseEventsOptions` 的原话是 forwards mouse move messages to Chromium），点击从来不转发。于是点击确实给了游戏，CSS `:hover` 照样跟着指针跑——半开半关比全开更像 bug。
- 修法：穿透只调 `setIgnoreMouseEvents(ignore)`，不开 `forward`。锁定 = 对鼠标完全无感：不亮、不拖、不滚；只有呼出面板打开时才恢复可点。
- 顺带：`createWindow()` 里也补一次穿透样式。`applyGeometry` / `togglePanel` 都会直接开窗，只在 `show()` 里设一次，等于把鼠标交给了一块没人管的透明窗口。

### 浮层交互：正常时「什么都不显示」
- 现状：锁定+正常捕获时，pill 整块隐藏——浮层是字幕，不是仪表盘。只有三种情况会出现一行字：回复框打开、配置态（未锁定）、以及「取不到字」。
- 「取不到字」由纯函数 `captureHint()` 判定，顺序固定：错误 → 没选区域 → 捕获暂停 → GSI 未进对局 → null。错误优先级最高，因为其他状态在报错时都不可信。
- 配置态（解锁）5 秒无操作自动锁回穿透：解锁是临时操作窗口，不是常驻状态。倒计时在 `OverlayManager.armIdle()`，渲染层用 `overlayKeepAlive()`（1 秒节流）推后它。
- 拖动松手时贴边吸附（`snapToEdges`，阈值 24px）：拖得再准也会留 1~2px 缝，换 DPI 就是一条亮边。
- 新行 400ms 亮黄；超过 12 行的旧行降到 55% 不透明度——保留上下文，又不糊满下半屏。

### FunASR 微调的两次「参数写错就炸」——都是 trainer 自己挖的坑

- 症状一：训练跑了 20 步后 `KeyError: 'model.pt.ep0.20'`，栈落在 `train_utils/trainer.py:198` 的 `save_checkpoint`。
- 根因一：`save_checkpoint` 无条件读 `self.val_acc_step_or_eoch[ckpt_name]`，而这张表只有 `validate_epoch`（`step_in_epoch % validate_interval == 0` 时触发）会写。官方脚本给的 `validate_interval=2000` 在几十步的小数据集上永远不触发，于是第一次存盘就撞空字典。
- 修法一：让 `validate_interval` 不大于 `save_checkpoint_interval`，校验先跑、存盘后跑；两边 `ckpt_name` 算法一致（都是 `model.pt.ep{epoch}.{step}`），所以名字对得上。
- 症状二：训练跑完、checkpoint 都写出来了，收尾却 `RuntimeError: No checkpoints found for averaging`（`average_nbest_models.py:65`）。
- 根因二：`_get_checkpoint_paths` 先从 `model.pt` 取 `val_acc` 表、按准确率取前 `avg_nbest_model` 个**文件名**，再逐个 `os.path.isfile`。表里记的是「每次校验」的名字，文件却只在「每次存盘」时写——`validate_interval=10` + `save_checkpoint_interval=20` 时最高分的名字是 `model.pt.ep0.10`，那个文件从来没存在过，于是 `state_dicts` 为空。实测日志第一行就是 `average_checkpoints: [... model.pt.ep0.10]`。
- 修法二：让 `validate_interval` **等于** `save_checkpoint_interval`（都 20），保证「有记录的都有文件」；再加 `keep_nbest_models=2`，否则 `keep_nbest_models=1` 会在存盘时删掉前一个文件、平均那步读到已删的名字（同一处报错的另一条触发路径）。`avg_nbest_model=1` 保留。代价是每次多留一个 checkpoint（paraformer-large 约 880 MB）。
- 症状三（2026-11-09 补）：修法二在 8 epoch 的增量跑里又炸了——同样的 `RuntimeError: No checkpoints found for averaging`。根因三是 keep 窗口和 avg 挑名是**两套账**：keep_nbest 是「存盘时看当时的 acc、删掉窗口外最差的**文件**」，avg 是「收尾读最后 `model.pt` 的 val 表、按 acc 挑前 `avg_nbest_model` 个**名字**再开文件」。8 个 epoch 全程 acc 钉死 0.4250（2 条验证数据 1 条 0.1，均值封顶，`>=` 平手永远不刷新 best），val 表首位 `model.pt.ep0.20` 早在第 5 个 epoch 就被窗口淘汰——窗口里有文件的名字不是表里最优的名字。实测 torch.load 最后的 `model.pt`：val 表前五全是 0.425 的平手（ep0.20/ep1/ep1.20/ep2/ep2.20），`saved_ckpts` 只剩 `['model.pt.ep7','model.pt.ep7.20']`。
- 修法三：`keep_nbest_models` 提到 **4**。窗口够宽就能盖住「表里最优的名字已在窗口外」的错位；代价是 run 目录多留两个 checkpoint（paraformer-large 每个 ~880 MB）。真正的盲测集拉开 acc 差距之前，这条就是唯一的稳妥解。
- 附带：`funasr.bin.export` 的 `++init_param` 必须是**权重文件路径**——`AutoModel` 只判 `os.path.exists`，给目录会直接进 `torch.load(dir)` 报 `IsADirectoryError`；量化后产物叫 `model_quant.onnx`，sherpa 认的是 `model.int8.onnx`，转正时按引擎表的 `artifacts` 映射改名。

### FunASR 导出的 paraformer 在 sherpa 里出乱码——两句错话叠在一起

- 症状：微调后的 paraformer 导出成功、`model.int8.onnx` 也在，交给 `resources/asr-sherpa-worker.cjs`（`kind=paraformer`）能加载，但识别结果是一串看似合理的中文乱码：「藜藜崐 ad 或玖贩纷鄮纷狈赐缴拧」。同一段音频用 FunASR 的 Pytorch 通路解出来是正确的「我没到还在冷却」，所以不是权重坏了。
- 根因一（元数据）：FunASR 的导出只写 `model.onnx` / `model_quant.onnx`，既不写 `tokens.txt`，也不写 sherpa 需要的图上 metadata。缺 `vocab_size` 时 sherpa 直接拒绝加载——`offline-paraformer-model.cc:Init:102 'vocab_size' does not exist in the metadata`；补上 `vocab_size / lfr_window_size / lfr_window_shift / neg_mean / inv_stddev / model_type / version` 才能开文件。这些值都能从底模目录推出来：`tokens.json` 给词表（8404 条，`<blank> 0` 起），`am.mvn` 的 `<AddShift>` 段就是 `neg_mean`、`<Rescale>` 段就是 `inv_stddev`（各 560 维，正好 80×7）。
- 根因二（导出参数）：`++model=` 必须给**底模 id 或底模目录**，不能给训练 run 目录。喂 run 目录时 `AutoModel` 会把 run 里的 `config.yaml`（hydra 存下来的训练配置）当模型配置读，导出半初始化的图——实测同一份 checkpoint 两种写法：正常写法导出 955 个 initializer、解出「我没到还在冷却」；喂 run 目录只导出 625 个 initializer、解出上面那串乱码。权重本身只动了 3e-6（一次小数据微调），不足以改变输出，所以乱码只能是图结构错。
- 修法：把「导出 → 量化 → 补 metadata/tokens」收进打包脚本 `resources/asr-ft-export-funasr.py`，argv 是 `--base <底模 id> --init-param <run>/model.pt --output-dir <out>`；脚本按 `tokens.json` 写 `tokens.txt`、按 `am.mvn` 补 metadata，产出直接叫 `model.int8.onnx`，转正时按引擎表 `artifacts` 拷过去即可。量化那步依赖 onnx ≥ 1.16：onnx 1.14 上会抛 `AttributeError: INT4`（`onnx.TensorProto` 那时还没有 INT4 成员）。

### 增量微调的起点必须是完整 zip——被停止的训练留下半成品权重

- 症状：面板点「开始训练（增量）」后 11 秒就 `失败 (exit 1)`，日志里只有 pytorch 的 `RuntimeError: PytorchStreamReader failed reading zip archive: failed finding central directory`。
- 根因：上一轮训练被用户停止时，`model.pt.best` 正写到一半，文件在但末尾没有 zip 的 EOCD（`50 4b 05 06`）。`incrementalWeightFile` 只按文件名优先级（`avg1 → best → model.pt`）挑，从不看内容，于是拿残件当起点；`torch.load` 立刻炸。同目录里 `model.pt` 是完整的，优先级却排在残件之后。
- 修法：`src/main/services/train/asr-ft.ts` 的 `torchArchiveIntact`（读末 66000 字节找 EOCD，<1KB 直接判坏）+ `usableIncrementalWeight`（挑第一个真完整的），`findIncrementalSource` 与 `stageIncrementalSource` 都用它；只剩残件时报「上一轮的权重是半成品（… 末尾缺 Central Directory，多半是训练中途被停止时正在写）：先做一次「从底模重训」」，复制到 `<现役目录>.next` 后再复验一次（大小不符 = 没抄全）。
- 附带修掉「失败原因等于没说」：`src/main/services/train/manager.ts` 的 `lastErrorLine()` 从日志尾巴取最后一条真错误行，stage 变成 `失败 (exit 1)：RuntimeError: …`，同时写进 runs.db 的 `error`。

### 起播那一下游戏静音又掉帧 = 预取把推理压在「正在念」的那一刻

- 症状：对讲出声的瞬间，Dota 的画面卡一下、游戏声音整片消失又回来；换成扬声器或蓝牙耳机都一样，说明跟游戏音频设备无关。
- 根因：`src/main/services/voice/speech-pipeline.ts` 的 sovits 表项原来是 `synthAhead: 1`——当前段的合成**一返回**就发下一段的推理请求，而这个时刻正好是当前段开始播放的时刻。本机 sovits 一句 20 字要 2–5 s，GPU 与显存一起被按住，而这块 8 GB 卡上 dwm 3.8 GB + sovits 服务常驻 2.8 GB + dota2 1.5 GB 已经占满，起播时再要显存就得换页，游戏跟着掉帧，音频引擎一并打嗝。
- 修法：sovits 改成 `synthAhead: 0`（播放期间不再发任何推理），代价是每段之间多等一次合成；`src/main/probes/tts-pipeline.ts` 的「段间预取」那块断言同步改成「本段出声时不发下一段的合成」。
- 怎么确认是这个原因：`data/logs/voice-chain.jsonl` 里看带 `seg>1` 的条目，改前改后 `firstAudioMs` 与 `speakMs` 的差值会明显变大（等待从段中挪到了段间），而 `logs/` 下 Dota 侧的卡顿不再出现。
- 真凶（2026-11-10 晚定位）：不是合成也不是往虚拟声卡播放，而是**按住 F6 时 Dota 自己开麦**——面板「测试模式」（只放音频、不按说话键）下完全不卡，一开正常模式就卡。Dota 的 `G:\steam\userdata\<id>\570\local\cfg\machine_convars.vcfg` 里 `snd_mixahead` 是 `0.001`（1 毫秒缓冲），开麦那一下的设备初始化就足以让音频线程欠载，表现就是整片静音再回来；同文件还有 `snd_ducktovolume 0.55` + `snd_duckerreleasetime 2.5`（语音活跃时把游戏音量压到 55%，2.5 秒才恢复）。
- 修法（游戏侧，不需要改 app）：`D:\SteamLibrary\steamapps\common\dota 2 beta\game\dota\cfg\autoexec.cfg` 末尾加 `snd_mixahead "0.05"`、`snd_ducktovolume "1"`、`snd_duckerreleasetime "2.5"`。用户在控制台先试 `snd_mixahead 0.05`，回「好像可以了」。
- 还可以再省一大笔：sovits 的 api_v2 常驻 2.8 GB 显存，不在说话时也不还；`dwm.exe` 3.8 GB 需要单独查（浮层收起后是否回落）。

### 同一句「翻译失败」盖住了三类完全不同的毛病（#86）

- 症状：对局里译文突然开始直连兜底，界面与日志只有一句「翻译失败」，用户不知道是 key 错了、服务商限流、还是网络抖了一下。三件事的下一步动作完全不同（改 key / 等一会 / 直接再试），一句泛化文案等于什么都不说。
- 根因：`src/main/services/providers/openai-compat.ts` 里所有失败都走同一个 `throw new Error('模型服务返回 HTTP …')`；`durable-translator` 的失败冷却又是一个定值 `RETRY_AFTER_MS = 30_000`——所以 429 之后整整 30 秒不去试会话层（白多付直连钱），而 key 错了反而每句都撞一次 401。
- 修法：`src/shared/provider-failure.ts` 一处判定（`no-key / auth / rate-limit / model-missing / timeout / network / server / bad-response / empty / unknown`），每类自带 `title + hint + retry + retryAfterMs`；`chatCompletion` 抛 `ProviderRequestError`（带 `failure`，`message` 就是 `failureLine()`）；`durable-translator` 的冷却改读每类的 `retryAfterMs`，`retry === 'no'` 的仍锁 30 秒直连。
- 两个容易判错的细节：Chromium 网络栈报的是 `net::ERR_CONNECTION_REFUSED`（下划线），Node 侧才是 `fetch failed: ECONNREFUSED`——只认后者会把「连不上」归成「原因不明」；超时必须用 `timedOut: err instanceof DOMException || /abort/i` 在 fetch 那一层判，到了上层只剩一句 `aborted`，分不出是超时还是用户取消。
- 验收：`npm run probe -- --provider-failure-probe`（19 条，含一条真连 `127.0.0.1:9` 的失败分类）；纯侧另有 8 条在 `scripts/check-pure.mjs`。
