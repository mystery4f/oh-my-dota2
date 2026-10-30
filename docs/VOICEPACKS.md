# 训练音色包（GPT-SoVITS 微调）

记录「每个训练音色从哪来、版本怎么管、怎么发新版」。这里的音色 = 参考音频 + 一对微调权重
（GPT `.ckpt` + SoVITS `.pth`），区别于 `VOICES.md` 里的离线 sherpa 模型。

## 版本管理规则

- **文件名就是版本号**：`windranger-e15.ckpt` 的 `e15` = GPT 训了 15 轮，`windranger_e8_s192.pth`
  的 `e8` / `s192` = SoVITS 第 8 轮第 192 步。重训出来的文件名必然不同，天然防串版。
- **分发目录 = 魔搭仓清单**：`a1078185271/oh-my-dota2-voicepacks` 仓库根放一份
  `voicepacks.json`（schema 见下），app 优先拉它（5 分钟缓存），拉不到才用编译进包的
  内置兜底清单（`src/main/services/voice/sovits-voicepack.ts` 的 `VOICE_PACKS`）。
- **发新版不发 app**：重训后把三个文件传到魔搭仓的 `<voice-id>/` 目录，改 `voicepacks.json`
  里对应包的 `version` 和文件名/字节数即可。用户端下一次拉清单就看到新版，点下载即换版。
- **换版清理**：装新版时旧权重文件（`gpt-sovits/weights/<id>/` 下不在新版清单里的）和
  本包目录下的旧参考音频自动删掉；其他音色/用户自建的参考永不触碰。
- **面板操作**：音色包下拉选包看详情（状态/版本/大小/说明），下载、重新下载（幂等补齐）、
  删除（正在使用的包会被拒绝，先切别的音色）。

## voicepacks.json 格式

```json
{
  "schemaVersion": 1,
  "packs": [
    {
      "id": "windranger",
      "name": "风行者",
      "version": "e15",
      "note": "默认音色，引擎装完自动下载（约 230MB）",
      "default": true,
      "promptText": "谁能预测到这一幕？哦，等一下。是我。",
      "promptLang": "zh",
      "refAudio":   { "path": "windranger/windranger-arcana-ref-zh.wav", "bytes": 284666 },
      "gptWeights": { "path": "windranger/windranger-e15.ckpt", "bytes": 155312333 },
      "sovitsWeights": { "path": "windranger/windranger_e8_s192.pth", "bytes": 85007488 }
    }
  ]
}
```

校验是严格的：单个包字段坏/路径越权（`..`、反斜杠、绝对路径）/字节数非法 → 该包整条剔除，
其余照用；一条都不剩或 schemaVersion 不认 → 整份作废，走内置兜底。

## 重训发版清单

- 训练产出在 `D:\AI\GPT-SoVITS-v2pro-20250604`（`GPT_weights_v2/` + `SoVITS_weights_v2/`）
- 参考音频用哪段、转写文本是什么，记到下面的溯源表
- 三个文件传魔搭仓：`python scripts/ms-voicepack-upload.py local:repo …`（先 `--dry-run` 看计划；令牌走 env `MS_TOKEN`，要用 GPT-SoVITS 的 runtime python，SDK 在那边）
- 改仓里的 `voicepacks.json`：`version`、三个 `path`、三个 `bytes`（`--manifest` 传上去）
- 溯源表加一行，发布流程细节见 `.pi/skills/dota-voice-release`
- 本地开发验证：`npx electron out/main/index.js --sovits-voicepack-probe`（41 项全绿），面板下拉应显示新版本号，「重新下载」走增量补齐

## 音色溯源表

| 音色 id | 名字 | 训练日期 | GPT 轮次 | SoVITS | 参考音频 | 参考转写 |
|---|---|---|---|---|---|---|
| windranger | 风行者 | 2026-10 | e15 | e8/s192 | `windranger-arcana-ref-zh.wav`（至宝语音提取） | 谁能预测到这一幕？哦，等一下。是我。 |
| mirana | 米拉娜 | 2026-10 | e15 | e8/s336 | `mira_per_spawn_13.mp3`（复活语音） | 从银夜森林到太阳帝权人们都是怀着敬畏和尊重说出我的名字 |

- 训练底座：GPT-SoVITS v2Pro（`gsv-v2final-pretrained` 三件套，随 8.2GB 引擎包分发）
- 增加零样本音色（如晓晓/晓伊）：不用训练，参考音频进 `tts/sovits-refs/` 的 refs.json 即可
  （不带 `gptWeights`/`sovitsWeights` 字段，走底座零样本推理）
- 新英雄音色流程：训练 → 传魔搭仓 → `voicepacks.json` 加一条 → 完事，不需要发 app

## 落位（数据根，重装引擎不冲掉）

- 参考音频 → `tts/sovits-refs/<id>/<原名>`，`refs.json` 由安装流程代写（用户仍可手编）
- 微调权重 → `gpt-sovits/weights/<id>/<原名>`

## 仅存本地的资产（丢了无法重训）

| 资产 | 位置 | 大小 | 说明 |
|---|---|---|---|
| 原始数据集（vpk 提取 + ASR 转写） | `D:\AI\windranger-finetune\` | 4.4MB | 风行者 58 条数据集的源头 |
| 同上 | `D:\AI\mirana-finetune\` | 43MB | 米拉娜 209 条 |
| 训练配置 | `D:\AI\GPT-SoVITS-v2pro-20250604\logs\<hero>\config.json` | 2KB | 实验参数（语义/批次/轮次） |
| 中间轮权重 e5/e10、e4 | `{GPT,SoVITS}_weights_v2\` | ~720MB | 在用版本已在魔搭，这些是备胎 |

在用权重、引擎、参考音频都在云端（魔搭）或数据根，上面这些是仅存本地的部分——换盘/重装前先打包这两个 finetune 目录。

