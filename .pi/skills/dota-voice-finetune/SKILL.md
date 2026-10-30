---
name: dota-voice-finetune
description: 用 GPT-SoVITS 给 Dota 2 英雄配音做中文音色微调训练。当用户要求「训练 XX 英雄的语音/音色」「给米拉娜/某某做微调」「换英雄音色」时使用。覆盖：vpk 语音提取 → funasr 转写 → 回声清洗 → 预处理 → s2+s1 训练 → 切换 tts_infer.yaml 全流程。
---

# Dota 2 英雄语音 GPT-SoVITS 微调

风行者至宝已跑通完整闭环（64 条语音 → 58 条数据集 → 10 分钟训练 → 应用内可用），本 skill 把那条路参数化，换英雄只需替换名字与音频来源。

## 前置状态（一次性，已就绪勿重复安装）

- 整合包：`D:\AI\GPT-SoVITS-v2pro-20250604`（runtime python 自带 funasr 1.0.27）
- 机器：RTX 4060 Laptop 8GB，显存贴上限但稳（游戏别开）
- `runtime/Lib/site-packages/users.pth` 必须指向当前包位置（包挪过位置会炸 `No module named 'text'`）

## 全流程

```mermaid
graph LR
  A[vpk 提取语音] --> B[funasr 转写] --> C[回声清洗] --> D[预处理三步] --> E[s2+s1 训练] --> F[切 tts_infer.yaml] --> G[试听验收]
```

### 提取英雄语音（vpk）

- 语音在 `D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk` 的 `sounds/vo/<内部名>/`。**内部名是旧名**：米拉娜=mirana，风行者=windrunner（不是 windranger），露娜=luna。
- 简中配音在 `dota_schinese` vpk。工具：Source2Viewer-CLI（GitHub release，走代理 `http://mcr:4444`），vsnd_c 直接反编译出 mp3。
- 产物放 `D:/AI/<hero>-finetune/raw/`（wav/mp3 都行，GPT-SoVITS 预处理会统一转 32k）。
- 若该英雄有至宝/套装语音，前缀如 `wr_arc_*`，优先收集（音色辨识度高）。英文台词转写可从 Dota Wiki 的 Responses 页 MediaWiki API 拿（`api.php` 带 Chrome UA 可用，网页 403）。

### 转写（funasr）

```
cd /d D:\AI\GPT-SoVITS-v2pro-20250604
set PYTHONIOENCODING=utf-8
runtime\python.exe -X utf8 <skill>/scripts/asr_transcribe.py D:\AI\<hero>-finetune\raw D:\AI\<hero>-finetune\asr-out\raw.list
```

纯笑声/无语音条目转写为空，下一步过滤。

### 清洗（游戏配音专属坑）

游戏配音自带混响尾巴，ASR 会把尾音写成重复词（「吹起吹起」）。`scripts/clean_asr.py` 两条规则：
- 尾部回声：`t[:-k].endswith(t[-k:])` → 删尾部 k 字（k 8→2 降序试）
- 串内相邻重复：`t[j:j+k]==t[j+k:j+2k]` → BB→B

开头改三行路径 + `GT` 字典（官方逐字文本兜底，来源：`pak01_dir.vpk` 内 `resource/localization/hero_chat_wheel_schinese.txt` 的 `dota_chatwheel_message_<内部名>_arcana_*`，语音轮盘通常只有 2-3 条）。长度 <2 的丢弃，输出 `cleaned.list` + clean-report.txt（人工抽查 report）。

### 预处理 + 训练

`scripts/build_train_configs.py`（开头改 `OUT_DIR` 与 `name`）→ 生成 `.tmp/tmp_s2.json` + `.tmp/tmp_s1.yaml`；然后 `scripts/prep_finetune.cmd`（text/hubert/semantic 三步）→ `scripts/train_finetune.cmd`（s2 后 s1 串行）。

- 风行实测配置：s2 bs=5 epochs=8 grad_ckpt=True；s1 bs=6 epochs=15。小数据（~60 条）总耗时 ≈10 分钟；1.25-1.4s/步。
- **复刻 webui 流程必须连 `os.makedirs(logs/<exp>/logs_s2_v2)` 和权重目录一起复刻**，否则 s2 存档时 FileNotFoundError。`build_train_configs.py`/cmd 里已含。
- 训练产物：`SoVITS_weights_v2/<hero>_e8_s192.pth` + `GPT_weights_v2/<hero>-e15.ckpt`（含中间 epoch 档，选最终档）。

### 切换与验收

改 `D:\AI\GPT-SoVITS-v2pro-20250604\GPT_SoVITS\configs\tts_infer.yaml` 的 `custom:` 段两行：

```yaml
  t2s_weights_path: GPT_weights_v2/<hero>-e15.ckpt
  vits_weights_path: SoVITS_weights_v2/<hero>_e8_s192.pth
```

应用侧（oh-my-dota2）零改动——sovits.ts 只打 `/tts`。重启 api_v2（或重启应用，托管会拉起）后试听：

```
curl "http://127.0.0.1:9880/tts?text=测试一句话&text_lang=zh&ref_audio_path=<参考wav绝对路径>&prompt_text=<逐字转写>&prompt_lang=zh&media_type=wav&streaming_mode=false" -o test.wav
```

参考音频仍要配（微调后定韵律用）：挑一条 3-10s 无底噪的该英雄台词（spawn/move 类优先；battlebegins/win/lose 叠背景音乐，米拉娜实测参考音频带底噪直接毁音色，已废弃），填进应用面板或 `data/settings.json`（`ttsSovitsRefAudio`/`ttsSovitsPromptText`）。

## 硬坑清单（全部踩过）

- cmd 脚本必须纯 ASCII，中文注释在 GBK 控制台炸行（同 ps1 规矩）
- `users.pth` 指向旧目录 → `No module named 'text'`（整包挪位置后必查）
- webui 会预建 `logs/<exp>/logs_s2_v2`，复刻驱动漏 makedirs → 存档 FileNotFoundError（已把 mkdir 焊进 train_finetune.cmd；教训：换数据集重训时废弃轮删掉 logs/<exp> 会复踩，修复必须固化在脚本里而非记忆里）
- bg_run 长驻训练/服务别传 `timeoutSeconds`（大值会被解析成异常立即杀树）
- 训练时 Dota 必须关：显存 8GB 贴上限，游戏一开必 OOM
- 转写清洗后必须人工抽查 clean-report.txt，ASR 错字直接进模型口音
- clean_asr 的 GT key 正则必须剥全扩展名（`\.(wav|mp3|flac)$`，已修）：只剥 .wav 时 mp3 数据集 GT 全失效（gt=0）
- 尾部单字回声（「米拉娜娜」「休想想」）与串内单字重复（「因因」）dedupe 抓不到（k 从 8 降到 2 漏 k=1），人工核听填 GT
- api_v2 的 `-a` 只收裸地址，端口走 `-p`：`-a 127.0.0.1:9880` 整串当主机名 → uvicorn getaddrinfo failed（WinError 11001）自杀退出，正确写法 `-a 127.0.0.1 -p 9880`
- 参考音频时长必须在 3~10 秒（服务端硬校验），选材前用 librosa.get_duration 量一遍
- 官方简中台词文本拿不到（biligame wiki api 重定向挡死）时不必追求官方对齐：clean_asr 加 TEXT_FIX 做发音级专名统一（全数据集拼法一致 + 发音贴音频即可），整句乱码进 DROP 丢弃；GPT-SoVITS 只吃读音匹配，不认字面权威
- 权重文件名 s 步数随数据量变（58 条=s192、68 条=s224），切 tts_infer.yaml 前 ls 确认真名
- api_v2 模型加载完成前 /tts 返回 400/500，就绪探测后须再发一次真请求才算通
