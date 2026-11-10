# 对讲行的阶段留痕（voice-stage-trace）

## 背景

浮层对讲行在整条链上只写一句「翻译中…」。`src/main/services/reply/reply-service.ts` 的 `voiceReply`
在一次 IPC 里把翻译、剪贴板、合成、按说话键、播放全做完，渲染端
`src/renderer/src/overlay/voice-capture.ts` 只能等它返回；那行字还是 CSS 伪元素
（`overlay.css` 的 `.row.pending .orig::after`），连动态文本都装不下。

实测 157 条对讲（`data/logs/voice-chain.jsonl`）p50 总耗时 5372 ms，其中起播 1999 ms、播放 1600 ms
两段都发生在译文已经到手之后，标签却仍写「翻译中」——标签名字错了腿。用户要求链上每个阶段都要出现，
并且明确不接受「短于 1 秒的段不上浮层」。

## 可选项

- **借时间**：每段标签排队，最少停留 200–300 ms，尾部加速追帧。每个阶段都能读到，代价是标签整体
  落后于事实，最多可能落后 0.5 s——而 0.5 s 正是最容易看出「它和声音不同步」的量级。
- **留痕**：短段不占时间片，完成即成为行上的标记；只有真正还在持续的段显示为进行中。

## 决定

采用留痕。

## 为什么不是借时间

短段不是边角情况。账本命中时翻译 1 ms（`src/main/services/session/durable-translator.ts` 的
`translateLine` 先 `lookupTranslation`，命中直接返回，不碰模型），157 条里翻译 ≤10 ms 有 49 条；
合成缓存命中 0–2 ms（`src/main/services/voice/sovits.ts` 的 `lookupSovitsCache`），首音 < 250 ms 有
36 条。1 ms 的文案在 60 Hz 屏上连一帧都排不上（一帧 16.7 ms），能否被看见取决于事件落在刷新周期的
哪个位置——即不处理就等于不显示。留痕把「看见」从时序问题变成布局问题：标记一旦写下就一直在，
与刷新周期、与停留策略都无关。

## 后果

- 阶段词汇与打点一一对应：`src/main/services/voice/chain-timing.ts` 的四个 `note*` 各完成一段并推一份
  快照，渲染端不自己算时间，两套时间不存在对不上的机会。
- 事件是快照而不是增量：掉一条只少画一次，行上永远是最近一次的完整状态。
- 结算后（`current === 'done'`，或这一行收到译文/错误的 patch）收掉后缀，数字归行内第三行
  （「已播 · 共 X」+ 五段拆解）：同一条行上不出现两份数字。
- 起播那 ~2 s 的拆账（`readyMs`/`keyMs`/`leadMs`）从此落进 `voice-chain.jsonl` 的 `prep` 字段；此前
  只打在 `VOICE_OUT_PREP` 的 stdout 上，事后无法归因。
- 本轮只覆盖对讲行。朗读（announce）腿没有任何计时记录，要接进来得先给它一份计时。
