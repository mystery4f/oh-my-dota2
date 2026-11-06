# oh-my-dota2

Dota 2 桌面伴生工具的领域语言：聊天摄取、翻译、语音对讲。术语按本表口径使用，同义词一律收敛到唯一术语。

## Language

**麦进（mic-in）**：
玩家按热键对着麦克风说话，本地转写成文字的入口。
_Avoid_: 录音、语音输入、ASR

**文出（chat-out）**：
译文以文字进游戏聊天框发送的通道。唯一实现是原地直发：控制台 say_team 与程序化打聊天框两条旧通道已移除。
_Avoid_: 粘贴发送、打字发送
**原地直发（in-place send）**：
热键触发：读游戏聊天框里已打好未发送的中文 → 翻译成英文 → 贴回同一输入框并回车。全程不切前台窗口；再按一次热键是打断重读。
_Avoid_: 直发（口语可，正式用全称）、inplace

**朗读（announce）**：
把捡到的聊天文本合成人声、从浮层扬声器直接念出来的管线。切不切、念不念在 decideSpeak，合成与投递统一走 speech-pipeline（announce 车道）；合成失败整句跳过，绝不回退系统嗓子。
_Avoid_: 播报、TTS 播放

**声出（voice-out）**：
译文合成英文人声、经虚拟声卡送进游戏语音频道，队友听到声音的通道。
_Avoid_: 麦克风输出、TTS 发送

**GV**：
GPT-SoVITS 音色克隆引擎在本项目的简称，加载英雄音色包做离线合成。
_Avoid_: so-vits、gptsovits

**音色包（voice pack）**：
一位英雄的一套微调权重与参考音频，可安装、切换、删除。
_Avoid_: 声音库、模型包

**说话键（push-to-talk key）**：
游戏内按住才发言的语音按键。它不是热键动作：这个键由游戏自己接管，本项目只在声出时替你按住再松开。
_Avoid_: V 键、语音热键

**全局热键（global hotkey）**：
向系统注册、不管当前哪个窗口有焦点都会触发的组合键；本项目所有全局热键都在面板里可改。
_Avoid_: 快捷键、系统快捷键

**热键动作（hotkey action）**：
一个「做什么」的意图（显示/隐藏浮层、锁定、收起、呼出面板、原地直发、语音对讲），键只是它当前绑定的组合。
_Avoid_: 命令、功能键

**浮层（overlay）**：
叠在游戏画面上的透明常驻窗口：双语消息行、状态提示、收起小图标都住在这里。锁定 = 点击穿透 + 防截屏；解锁才能拖动。它不是仪表盘——面板那种完整界面在主窗口里。
_Avoid_: 翻译区（只是收起小图标上的文案）、HUD、悬浮窗
**呼出面板（summon panel）**：
热键把浮层临时变成一个可交互面板：历史、快捷短语、AI 建议回复三个标签页，点行复制进剪贴板。关闭（再按热键或 Esc）即恢复穿透。它是浮层的一种临时形态，不是独立窗口。
_Avoid_: 回复框（已移除的旧形态）、快捷面板

**识别引擎（ASR engine）**：
本地转写用的引擎，本项目只保留 whisper ggml-small 与 Qwen3-ASR 两个；SenseVoice 已废弃移除。
_Avoid_: 识别模型（与文件层的模型文件混淆）

**热词（hotwords）**：
喂给 Qwen3 做词汇偏置的词表，改词表即时生效，专治术语选错；只在 Qwen3 引擎生效。
_Avoid_: 提示词、prompt、词典

**纠错回路（correction loop）**：
在识别记录里把错的转写改成对的，差异片段自动并入热词表的闭环。
_Avoid_: 训练、学习（它不更新模型权重）

**训练任务（training job）**：
一次可启动、停止、看进度的微调训练进程抽象；同一时间只允许一个在跑。
_Avoid_: 训练（口语泛指整个事情）

**数据集（dataset）**：
训练用的录音与对齐文本的集合：ASR 侧=读稿录音组，GV 侧=GPT-SoVITS 格式的切片与标注目录。
_Avoid_: 语料、素材

**部署口（deploy target）**：
训练产物接入运行时的落点：ASR=识别引擎模型目录，GV=音色包。
_Avoid_: 安装（安装专指音色包下载动作）

**训练窗口（training window）**：
管理训练任务与数据集的独立面板窗口，主面板只留一个入口按钮。
_Avoid_: 训练页

**推理互斥（inference hold）**：
训练任务占卡期间应用托管（app-managed）的 GV 推理服务自动暂停、任务退场自动恢复的互斥机制；端口上的外部服务不受影响。状态叫推理互斥状态（inference hold state）。


**实验名（experiment name）**：
GPT-SoVITS 引擎包 `logs/` 下一次备料实验的目录名；训练窗口的 GV 数据集下拉列的就是它。
_Avoid_: 数据集名

**备料（dataset preparation）**：
跑真训练前 webui 三步（1a 打标注 / 1b 微调训练 / 1c 语义）留下的四件套：音素表 `2-name2text.txt`、语义表 `6-name2semantic.tsv`、Hubert 特征 `4-cnhubert/`、32k 音频 `5-wav32k/`；四件套齐 = 可开训。
_Avoid_: 数据准备

**两腿（two legs）**：
GV 微调的两条训练线——SoVITS 声学模型（`s2_train.py`，`--config`）和 GPT 语义模型（`s1_train.py`，`--config_file`）；注册音色包要两腿的产物都有。
_Avoid_: 阶段

**录音组（recording group）**：
训练窗口按读稿 `## Gxx` 划分的录音单元；有编号句的叫逐句组（lines），没有的叫自由说组（free）。
_Avoid_: 组（口语泛指）

**录音段（take）**：
一次录制得到的音频，键 `Gxx-Lnn`（逐句）/ `Gxx-Tnn`（自由说）；短于 minMs（400ms）或全程没检测到说话会被丢弃。
_Avoid_: 录音文件

**编排器（orchestrator）**：
app 在训练产线里的角色——下命令、收日志、管产物；训练本身仍跑在各自的 python 栈里。
_Avoid_: 内置训练

**推理互斥（inference preemption）**：
训练运行时自动暂停 GV 推理服务、训练结束自动恢复，防止 8G 显存打架。
_Avoid_: 显存管理

**供应商（provider）**：
一个可切换的翻译接入，面板一次只有一家「当前生效」；内置六家 id（deepseek/openai/ollama/mimo/zhipu/custom），换供应商不丢各自的 key 与推理开关。
_Avoid_: 厂商、渠道、服务端

**预设（preset）**：
内置供应商表 `PROVIDER_PRESETS` 的一行：接口地址、模型、可选 `authStyle` 与声明的推理开关；换预设即换家，声明过的字段载入时以声明为准。
_Avoid_: 模板、方案

**密钥归档（key archive）**：
settings 里按供应商 id 各记一把的 API Key 表（`providerKeys`）；key 框只是当前生效那把的编辑面，切供应商从归档取回，载入时非空活值永远写回归档。
_Avoid_: 密钥库、钥匙串、缓存

**推理开关（reasoning toggle）**：
让模型先思考再回答的开关，按供应商各记各的：当前格 `provider.reasoning` + 归档 `providerReasoning`；默认关——翻译是短句任务，思考只加延迟。
_Avoid_: 思考模式、深度思考
