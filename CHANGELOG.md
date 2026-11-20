# Changelog

逐条提交历史看 `git log`（Conventional Commits）；这里只留「发出去的版本里有什么」，一个版本一节。
## v1.2.0

- 热词候选（讲话页）：纠错样本里反复出现的差异词（≥2 字）现在攒成一份候选清单，面板按次数排序列出，
  勾选后点一次「并入热词表」才写进 `asrHotwords`。**永不自动应用**；一次并入只写一次设置（写一次 =
  识别器重载一次）；表满 50 词时挤不下的词单独列出来，不静默丢弃；「忽略」只清候选不动设置。
  候选池落 `<数据目录>/asr-hotword-candidates.json`，删掉只等于重新攒（`--hotword-candidates-probe`）。
- GSI 对局归属：`logs/voice-chain.jsonl` 每行带 `matchid`（只认 90 秒内的活帧，拿不到写显式 `null`，
  绝不猜）；`gsi-summary.json` 换局时先归档到 `logs/gsi-summary/<matchid>.json`，只留最新 20 份，
  当前局永不删（`--match-attribution-probe`）。复盘页从此能按局把对讲行与局小结对起来。
- 上手检查（总览页）：原来的「一键自检」换成六步证据链——供应商密钥、GSI 配置路径、识别模型、热键、
  数据目录、真实帧。每步给出可核对的证据（路径 / 延迟 / 几秒前收到帧 / 哪个键被占），最后一步
  只认真游戏帧（cfg 只在 Dota 启动时读，所以文案就写「进游戏后点这里」）。顺带兜住多 Steam 库、
  中文路径（GBK/utf8 双解码 + `existsSync` 验真）、移动硬盘换盘符三处（`--first-run-probe`）。
- 保真守卫可量化：守卫拦下的译文不再只打 console，按批写 `logs/translate-guard.jsonl`，记「判违例 /
  重试救回 / 退回原文」三段与可疑词。漏检率测不出来（模型译坏而守卫没抓到时没有第二判官），这一点
  写进了 ADR，不假装有数。翻译记账本同批落 `logs/translate-cache.jsonl` 快照。
- 新增供应商豆包（Volcengine Ark）及其思考开关；每次启动开新会话，翻译记账本改为重建而不是退化成内存。
- 说话人归属：每句对讲记录实际打开的录音设备（label + id 前 8 位），静音设备会被点名。
- 浮层：锁定后对鼠标彻底隐形（不再透传 hover）；「游戏盖住浮层」给的是真实原因（独占全屏）而不是
  一句 z-order 猜测；对讲行显示链路阶段。
- 语音链路的修：短按住不再丢首字（麦克风常热）、松手早于麦克风打开也认、录音判定改看最响的 100 ms、
  sovits 不再边播边预取、蓝牙耳机不再被切到通话通路。
- 热词编辑重做（讲话页）：热词行改成 chip 编辑器——回车或打出分隔符成词、× 删除、Backspace 删末词，落盘永远是规范串，按词提交不再逐键保存（worker 的识别器不跟着敲键重载）。表满 50 词拒收新词并计数显示，纠错自动并入走同一上限（`mergeHotwords` 封顶，`--asr-hotwords-probe` 锁行为）。现役引擎不吃热词时（paraformer）整行只读并说明原因，qwen3 现役恢复编辑。

- 去掉对讲总开关 `voiceCaptureEnabled`：热键 `voiceCapture` 恢复为默认注册，按住轮询进程照旧随启动拉起，
  不想要时把热键在「浮层与对局 → 热键」里清空即可。v1.1.1 那个「默认关」开关留着只会让升级后的人以为功能坏了。



## v1.1.1

- 对讲（语音对讲）链路分段计时：新增 `voiceShowTiming` 开关（**默认关**），开着时一句对讲量出识别 / 译 / 首音 / 起播 / 播完
  五段，浮层聊天行与面板「识别记录」都带一行拆解，原始记录落 `logs/voice-chain.jsonl`（256 KB 截断）。
- 起播内部再拆四段（控制台 `VOICE_OUT_PREP`）：枚举输出设备、base64→blob 加 `setSinkId`、等 `loadedmetadata` 解码、
  按说话键，外加首段余量。真机实测 1.8–2.7 s 全在按键上——每按一次都新起一个 PowerShell 进程（裸启动 880 ms，
  脚本里的 `Add-Type` 再 0.35 s）。
- 对讲总开关 `voiceCaptureEnabled`（**默认关**）：关着时不注册 `voiceCapture` 热键、不起按住轮询进程，默认安装不会
  为这条链跑任何进程；面板「对讲 → 语音对讲」里开。
- 探针：`--voice-chain-probe` 覆盖计时器与两个格式化函数并进 CI 纯探针名单；`--settings-persist-probe` 覆盖新开关。
- 文档：`docs/BENCH.md` 补真机实测与起播拆解，`docs/TODO.md` 记下达不到预期的常驻按键方案与原因。
