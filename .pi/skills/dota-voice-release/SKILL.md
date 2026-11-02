---
name: dota-voice-release
description: oh-my-dota2 训练音色包的发布与版本管理。当用户说「训练完了发上去」「更新音色包清单」「发新版音色」「上传权重到魔搭」「音色包版本管理」时使用。训练本身用 dota-voice-finetune skill，本 skill 覆盖训练产出 → 魔搭上传 → 清单更新 → 验证 → 记录的发布链路。
---

# 音色包发布（训练之后做什么）

训练闭环：`dota-voice-finetune`（训练）→ **本 skill（发布）** → 应用面板「升级」（用户侧换版；从未装过的用户仍走自动下载）。

核心心智模型：**文件名就是版本号**（`windranger-e15.ckpt` = GPT 15 轮），**魔搭仓是唯一分发中心**，
**发版不发 app**——重训只改魔搭仓里的文件和 `voicepacks.json`，用户端 5 分钟缓存内自动看到新版。

## 资产地图（2026-11-02 盘点）

| 资产 | 位置 | 独一份？ |
|---|---|---|
| 微调权重（在用 wr e15-854/s1384、mira e15-s3520） | `D:\AI\GPT-SoVITS-v2pro-20250604\{GPT,SoVITS}_weights_v2\` | 否，魔搭有 |
| 中间轮权重（wr e4/e5/e10+s692、mira e5/e10+s1760） | 同上 | **是，仅本地** |
| 上一代在用权重（wr s192、mira s336，回滚用） | 同上 + 魔搭旧路径 | 否，魔搭有 |
| 原始数据集（vpk 提取+ASR） | `D:\AI\windranger-finetune\`（137MB）、`D:\AI\mirana-finetune\`（173MB） | **是，仅本地，丢了无法重训** |
| 训练配置 | `D:\AI\GPT-SoVITS-v2pro-20250604\logs\<hero>\config.json` | **是，仅本地** |
| 分发仓 | 魔搭 `a1078185271/oh-my-dota2-voicepacks`（10 权重 2 代并存 + voicepacks.json + README.md） | 云端 |
| 引擎 8.2GB | 魔搭 FlowerCry 镜像（可重下）+ `G:\oh-my-dota2-data\gpt-sovits\` | 云端 |
| 溯源文档 | `docs/VOICEPACKS.md` | git 仓 |

安装版**零依赖 D:\AI**（`ttsSovitsHome` 空、引擎/权重/参考全在数据根）；dev 模式的 `data/settings.json`
仍指 `D:\AI` 引擎（有意，省 8.2GB 重复安装，换机器才要处理）。

## 发布流程

```mermaid
graph LR
  A[选 3 个文件] --> B[上传魔搭] --> C[改 voicepacks.json] --> D[传清单] --> E[匿名验证] --> F[更新溯源表]
```

### 选文件

每包固定三件，从训练产出挑「在用版本」：

- GPT 权重：`GPT_weights_v2/<hero>-e<N>.ckpt`（~148MB）
- SoVITS 权重：`SoVITS_weights_v2/<hero>_e<N>_s<M>.pth`（~81MB）
- 参考音频：几秒 wav/mp3 + 记住转写文本（面板 prompt 用的就是它）

字节数必须 `ls -l` 实测（清单校验是精确字节比对，差 1 字节都不装）。

### 上传

```bash
export MS_TOKEN=ms-xxxx   # 用户魔搭令牌，问用户要，绝不进 git
D:/AI/GPT-SoVITS-v2pro-20250604/runtime/python.exe scripts/ms-voicepack-upload.py \
  "D:/AI/GPT-SoVITS-v2pro-20250604/GPT_weights_v2/<hero>-e20.ckpt:<hero>/<hero>-e20.ckpt" \
  "D:/AI/GPT-SoVITS-v2pro-20250604/SoVITS_weights_v2/<hero>_e20_sXXX.pth:<hero>/<hero>_e20_sXXX.pth" \
  "D:/AI/<hero>-finetune/raw/<ref>.wav:<hero>/<ref>.wav"
```

先 `--dry-run` 看计划再真传。`--manifest` / `--readme` 是清单和模型卡的快捷方式。

### 改清单

仓库根 `voicepacks.json`（本地编辑源：`.tmp/voicepack-upload/voicepacks.json`，或先匿名拉最新再改）：

- 对应包改 `version`（短标签，如 `e20`）、三个 `path`（仓库相对路径）、三个 `bytes`（实测值）
- 新音色 = `packs[]` 加一条（id/name/note/promptText/promptLang + 三件套）
- schema 见 `docs/VOICEPACKS.md`；改完 `--manifest` 传上去

### 验证与记录

- 匿名 GET `https://www.modelscope.cn/models/a1078185271/oh-my-dota2-voicepacks/resolve/master/voicepacks.json` 应 200 且内容正确
- 应用侧：面板「浮层与对局 → 引擎与嗓子」音色包应显示「● 有新版 v旧 → v新」+「升级」按钮（6b674c1 起：装包时把 packId/packVersion 记进 refs.json，清单 version 一变面板就报可升级；点「升级」增量补齐，换版自动清旧权重，refs 同名自动替换并更新版本记录）。注意：自动装包只对**从没装过**的包生效，老用户必须手动点「升级」
- 回归：`npx electron out/main/index.js --sovits-voicepack-probe`（54 项全绿，含 v1→v2 清单升级链路）
- `docs/VOICEPACKS.md` 溯源表加一行（训练日期/轮次/参考音频来源/转写文本）

## 已知坑

- modelscope `HubApi.upload_file` 只吃 kwargs（path_or_fileobj/path_in_repo/repo_id/token），位置参数 TypeError
- `create_model` 不能给已存在仓库改中文名（400），模型卡就是仓库 README.md，SDK 改不了的去网页改
- 魔搭直链首次响应可能 302 跳 CDN，跟随重定向才是真 200/206；Range 断点续传真实可用（206 + Content-Range）
- 清单里 `promptText` 必须与参考音频严格对应，抄错一个字 = 合成质量劣化但不报错
- 删除正在使用的音色包会被应用拒绝（active 判定看 `settings.ttsSovitsRefAudio`），这是设计不是 bug
