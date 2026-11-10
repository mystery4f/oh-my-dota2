# Changelog

逐条提交历史看 `git log`（Conventional Commits）；这里只留「发出去的版本里有什么」，一个版本一节。

## Unreleased

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
