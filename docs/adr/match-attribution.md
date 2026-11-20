# 一行话属于哪一局：matchid 归属与按局归档

状态: current · 2026-11-20 · 对应 issue #73

## 要解决的问题

两样东西都没法回答「这一晚发生了哪几局」：

- `logs/voice-chain.jsonl`：一句对讲一行，但行上没有局的概念。复盘页要对着一局讲
  故事，不知道这行是哪一局的。
- `logs/gsi-summary.json`：自应用维护的活文件，`map.matchid` 一变就清账重写，
  于是一晚上打三局，盘上永远只剩最后一局。

## 决策

- **对讲行永远带 `matchid` 字段，且永远是显式的**：知道就是字符串，不知道就是
  `null`（菜单、看录像、GSI 断了）。`null` 是「没有这一局」，不是「上一个 id 的
  alias」——猜错会把两局混成一个故事，比没有归属更糟。
- **只认活着的帧**：`src/main/services/gsi-match.ts` 的 `noteLiveMatch()/liveMatchId()`
  以帧到达时间计，超过 `MATCH_ATTRIBUTION_TTL_MS`（90 秒，与 gsi.ts 的
  `HEARTBEAT_TIMEOUT_MS` 同量级）没有新帧就回到 `null`。谁要写行谁就调
  `liveMatchId()`，谁也不用自己去问 GSI「现在在哪一局」。
- **一局一份归档**：`gsi-summary.json` 是活文件，只装当前局；换局先把上一局另存到
  `logs/gsi-summary/<matchid>.json`（原子替换：`<file>.tmp` → rename）。归档不只等
  `POST_GAME`——秒排重开、掉线重连都会在没有 `POST_GAME` 的情况下换局，所以
  `recordFrameSummary()` 发现 matchid 变了就先归档。
- **保留上限**：归档只留最新的 20 份（`SUMMARY_KEEP`，写死在
  `gsi-summary-archive.ts`）。**当前这一局永不删**，即使它是最老的一份——删了自己的
  活数据是最不该发生的事。
- **matchid 进文件名前净化**：`archiveName()` 只留 `[0-9A-Za-z_-]`，脏 id 不许把文件
  写到目录外。

## 为什么不在别处做

- 不给 GSI 服务开「当前 matchid」的公开 getter 让写行的人去轮询：写行的地方（对讲
  计时、将来复盘页）只该有一个便宜的读取点，围绕「现在在哪一局」的耦合应当收敛到
  `gsi-match.ts` 一个模块。
- 不在写行处用 `gsiStatus().matchId`：那是运行时状态，而且 90 秒判死逻辑藏在
  GSI 服务里；挪出来显式表达为「TTL 内的活帧」才能在探针里离线钉死。

## 验收与证据

- 探针 `--match-attribution-probe`（ci: true）：归属纯函数（null 起始、TTL 内/外、
  脏帧不覆盖）、净名函数、纯 prune 判定（25 删 5、当前局永不删、数字排序）、真走
  `recordFrameSummary()` 两局（活文件只装第二局、归档各有一份）、对讲行
  matchid（对局中带 id、断线后显式 null）。已实测 `passed:20, failed:0`。
- 纯函数（`archiveName` / `pickPrunable` / 三件套）不依赖 Electron，可离线复算。

## 影响面

- `voice-chain.jsonl` 每行多一个 `matchid` 字段（老行没有就是没有，读方按缺省
  「无归属」处理）。
- `gsi-summary.json` 的语义从「晚点看那一眼」变成「活文件 + 归档目录」，改动点：
  `gsi-frames-summary.ts`（换局先归档）、`gsi.ts`（每帧 `noteLiveMatch`）、
  `chain-timing.ts`（写行取 `liveMatchId()`）、探针与 `docs/PROBES.md`。
- 复盘页（#71 之后、依赖本条的后续工作）从此能按 matchid 把对讲行和局小结对起来。