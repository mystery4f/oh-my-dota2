---
created: 2026-10-31
updated: 2026-10-31
tags: [tts, sovits, rejected]
---

# ADR：念白限长 60→40（否决）

## 背景

语义 token 随文本长度线性涨，60 字长句切 3 段占卡 3 次。提议把 `SPEAK_MAX_CHARS` 收到 40，省 1/3 最坏情况显卡时间。

## 决定

不做。用户原话：「正常没人打这么多字」——长句本身就是低频路径，为它牺牲朗读完整性不值。已实现的丢弃积压 + 重复缓存已覆盖主要浪费。

## 保留物

`SPEAK_MAX_CHARS = 60`（`src/main/services/voice/speech.ts`）维持不动。若未来实测长句占比高，再重启此案。
