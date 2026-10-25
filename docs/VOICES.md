# 音色库（离线朗读）

记录「一个音色从哪来、怎么装、实测什么水平」，避免每次重新找。

## 下载源

官方模型仓库（sherpa-onnx，全部 tts 模型的发布页）：

```
https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
```

每个模型是一个 `tar.bz2`，URL 规律固定：

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/<模型名>.tar.bz2
```

下载后解压（Windows 自带 `tar.exe` 就是 bsdtar，认 bz2）：

```bash
tar -xf vits-zh-hf-keqing.tar.bz2
```

目录结构与「我们的引擎怎么读它」：

| 布局 | 特征文件 | 引擎配置 |
|---|---|---|
| piper | `espeak-ng-data/` + `<name>.onnx` + `tokens.txt` | `vits: { model, tokens, dataDir: espeak-ng-data }`，无 lexicon |
| HF VITS | `lexicon.txt` + `dict/` + `*.onnx` + `*.fst` | `vits: { model, lexicon, tokens, dictDir }` + `ruleFsts` |
| MeloTTS | `model.onnx` + `lexicon.txt` + `dict/` + `*.fst` | 同上 |

中文模型的完整清单（`gh api` 查发布资产，比翻文档页全）：

```bash
gh api repos/k2-fsa/sherpa-onnx/releases/tags/tts-models --paginate --jq '.assets[].name' | grep -Ei "zh|cantonese" | grep tar.bz2
```

2026-11 当时的清单：

```
matcha-icefall-zh-baker         matcha-icefall-zh-en           sherpa-onnx-vits-zh-ll
sherpa-onnx-zipvoice-{distill-,}{int8-,fp32-,}zh-en-emilia
vits-cantonese-hf-xiaomaiiwn    vits-icefall-zh-aishell3       vits-melo-tts-zh_en
vits-piper-zh_CN-chaowen-medium  vits-piper-zh_CN-huayan-medium  vits-piper-zh_CN-xiao_ya-medium
vits-zh-aishell3
vits-zh-hf-{abyssinvoker,bronya,doom,echo,eula,keqing,theresa,zenyatta}
vits-zh-hf-fanchen-{C,unity,wnj,ZhiHuiLaoZhe}
```

角色名（keqing / eula / theresa / bronya / zenyatta …）来自 HuggingFace 社区在 `csukuangfj/vits-zh-hf-*` 下做的角色微调，**名字只表示训练目标，不代表听感**——这几个模型都报 804 个说话人（共用同一张说话人表），实际音色由 `sid` 决定。

## 实测记录（2026-11，Ryzen 20 核 CPU）

| 模型 | 采样率 | 说话人 | 每句 | 结论 |
|---|---|---|---|---|
| vits-melo-tts-zh_en | **44.1 kHz** | 1 | 0.39–0.80 s | **当前默认**，中英混读，音质最好 |
| matcha-icefall-zh-baker | 22.05 kHz | 1 | 0.08–0.19 s | 最快，但音色发闷，用户当场否掉 |
| vits-piper-zh_CN-huayan-medium | 22.05 kHz | 1 | 0.49–0.58 s | 播音腔，规整但偏客服 |
| vits-piper-zh_CN-xiao_ya-medium | 22.05 kHz | 1 | 0.49 s | 更年轻一点，音量偏小 |
| vits-zh-hf-theresa | 22.05 kHz | 804 | 1.8–2.8 s | 角色名无效，靠 sid 挑 |
| vits-zh-hf-eula | 22.05 kHz | 804 | 1.5 s | 同上 |
| vits-zh-hf-keqing | 22.05 kHz | 804 | 1.9–4.2 s | 同上；语速下限 0.8（0.7 反而变短） |
| vits-zh-aishell3 | **8 kHz** | 174 | 0.4–0.7 s | 电话音质，淘汰 |

## 三个必须记住的坑

- `model.int8.onnx` 可能是 **133 字节的 Git LFS 指针**，不是模型。指过去后推理子进程直接被打崩，探针表现为「静默无输出」。先用 `ls -lh` 看大小。
- 语速不是线性的：keqing 在 `speed=0.7` 出来的时长比 `0.8` 还短。往低处压之前必须量时长，别凭感觉。
- 804 个说话人 ≠ 804 种好声音。同一模型里 sid 差异很大，扫一遍挑编号比换模型有效。


## 最终保留的四款（2026-11 定案）

用户把 16 个候选全部听过一遍后只留下这四个，**其余从代码与数据目录都已删除**（theresa / kokoro / keqing / fanchen / aishell3 / piper-chaowen 等）。下表是应用内实测（预热后 p50，跑 `--tts-offline-probe <id>`）：

| id | 名称 | 采样率 | 架构 | 包大小 | p50 一句 | 说明 |
|---|---|---|---|---|---|---|
| `melo` | MeloTTS | 44.1 kHz | vits | 183 MB | 0.47–0.50 s | 本组唯一高采样率，中英混读 |
| `baker` | Matcha icefall | 22.05 kHz | matcha + 声码器 | 100 MB + 53 MB | 0.09 s | 最快，声音偏闷 |
| `xiao_ya` | piper 小雅 | 22.05 kHz | vits | 60 MB | 0.11 s | 包最小，音色偏温柔 |
| `eula` | hf 角色微调 | 22.05 kHz | vits | 120 MB | 0.36 s | 804 个说话人，默认 sid 5 |

要点：

- **matcha 与 vits 不是换文件名就能换的**。vits 是「单个 onnx + tokens + lexicon + dict」；matcha 是「声学模型 + 独立声码器」，配置字段叫 `acousticModel` / `vocoder`，少一个都建不起引擎。代码里由 `MODEL_FILES[id].kind` 分派，worker 那侧也有对应分支。
- 声码器只下一次，放在 `tts-models/` 根目录共用：`vocos-22khz-univ.onnx`（vocoder-models 发布）。
- **中文单语包没有 espeak-ng-data**，别给 sherpa 传 `dataDir`——传了它去找 `phontab`，直接报 config 错。中文分词靠 `dict` 目录（`dictDir`）；piper 的包连 dict 都没有，注册表里用 `dict: false` 标出来。
- 包里若同时有 `model.onnx` 与 `model.int8.onnx`，**取体积最大的**——int8 那个常常只是 133 字节的 Git LFS 指针，指过去会直接崩进程。
- 试听结论不能靠模型名推断，必须真听；角色名（eula / theresa / keqing）只表示微调目标。

## 试听工具（临时，不进仓库）

`.tmp/tts/` 下的脚本（`compare.cjs` / `sids.cjs` / `speed.cjs`）都是「一个模型 → 若干 WAV」的薄壳，用 `sherpa-onnx-node` 直接在纯 Node 里跑（Electron 运行时不能用，见 docs/NOTES.md 的 `External buffers are not allowed`）。试听用 PowerShell 的 `System.Windows.Media.MediaPlayer`，不必装播放器。
