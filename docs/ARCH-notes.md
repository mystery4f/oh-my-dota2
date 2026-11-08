# 架构细节（从 AGENTS.md 移出）

`AGENTS.md` 只留规则与导航指针；这里放各域的细节，改对应代码前按需读。
2026-11-08 从 AGENTS.md 原样搬出，正文未改。

---

## Panel

The whole dashboard is `src/renderer/src/panel/`, and it is the only dashboard: the old
`App.tsx` (2234 lines, 6 tabs) is gone, along with `components/hotkey-card.tsx` and the
`ui/{badge,card,label,tabs,textarea}` pieces nothing else imported.

- `panel-app.tsx` — the shell: 38 px drag title bar + `Sidebar` + one scrolling `<main>`.
  Navigation is the sidebar alone (no tabs); `?s=<section>` deep-links a section, and
  `OMD2_QUERY=s=talk` injects that query in dev.
- `sections.ts` — the ten sections and their two sidebar groups (系统: 翻译引擎 / 音色训练 /
  识别训练 / 热键). A page that exists in
  the switch only through `default: { const unhandled: never = active }` means a forgotten
  case is a compile error, not a blank screen.
- `pages/*.tsx` — one file per section. A page returns `Panel` / `Group` / `Row` only; the
  shell renders the `<Section>` heading, so no page repeats its own title.
- `components/primitives.tsx` — the entire typography and spacing scale lives here
  (`Panel` 720 px column, `Group` as a `border-t` list, `Row` at `min-h-11`, `StatusPill`,
  `CollapsibleGroup`). Change a spacing decision here, not per page.
- `components/search.tsx` + `search-index.ts` — Ctrl+K. A hit navigates to its section and
  force-opens the collapsed group it lives in (`openCollapseGroup`), otherwise searching a
  hidden row looks broken.
- `collapse.ts` — group open/closed in `localStorage`, read through `useSyncExternalStore`;
  `defaultOpen` seeds the first visit and an explicit toggle wins afterwards.
- `use-voice-packs.ts` + `components/voice-pack-dialog.tsx` — the voice packs live in one
  `Modal`, opened from both 朗读 and 对讲 (「音色包…」), never inline in a page: install,
  progress, switching and GV server settings are all rare, and inlining them pushed the
  common rows down. `useVoicePacks(active)` is the only reader of that state, and `active`
  is false while the engine is not sovits, so a closed dialog makes no IPC calls.
  The dialog is the only place a pack is chosen: both engine rows (朗读 / 声出) show the active
  pack name plus the 音色包… button, so adding a loader means touching one component instead of
  two pages that would drift.

Rules the layout encodes, not preferences: every setting has exactly one home; saving is
immediate, so there is no 保存 button anywhere (the flash says 已保存); a `StatusPill` is
only for state that can change (a static attribute such as 默认 is plain text); colour is
spent only on three things — selection, primary action, warning — so a page that looks
grey is the intended look. `docs/DESIGN-panel-v2.md` is the signed record; the
deliberate deviations are written down there (no extra token layer — the HSL variables in
`styles.css` already are one — and `rounded-lg` 8 px instead of the documented 10 px).

## Training (音色训练 / 识别训练)

Two sections, one shape: 数据 → 运行 → 产物. There is no training window and no
`train:open` channel — the standalone BrowserWindow was deleted in v3.

- `src/shared/train/run.ts` is the run model: `TrainRunRecord` plus the builders
  (`buildTrainRun`, `finishTrainRun`) and metric parsers (`parseAsrTrainerState`,
  `parseGvTrainLog`, `compactMetricSeries`). One run = one JSON under
  `userData/train-runs/`, written atomically by `services/train/run-store.ts`; a run is
  history, the training process is `TrainTaskInfo` — never conflate them.
- Metrics are read back from the artifacts (ASR `checkpoint-*/trainer_state.json`,
  GV `logs/<exp>/train.log`), not duplicated into the record.
- `src/shared/train/preflight.ts` is the gate: `judgeAsrPreflight` / `judgeGvPreflight`
  return `PreflightItem[]` where only `block` disables 开始训练; `warn` explains risk.
  Add a new gate there, never inline in a page.
- `panel/use-recorder.ts` owns mic capture (getUserMedia → ScriptProcessor → rms →
  `advanceRecording` → `shouldKeepTake` → `encodeWav16k` → `ftRecSave`). Page-level
  components stay free of audio plumbing.
- `npm run build` must stay silent about the training pages: no inline colours, no
  custom font sizes, at most one primary button per screen.

---

## Shipping

- `npm run pack:win` builds `out/` and then `electron-builder` produces `dist/oh-my-dota2-<version>-x64.exe`
  (NSIS installer) plus a portable `.zip`. Nothing is code-signed, so SmartScreen warns on first run.
- Three workflows: `ci.yml` (typecheck + lint + build on every push/PR), `nightly.yml` (every push to
  `main` packages a pre-release titled `Nightly <UTC timestamp>`; every older nightly is deleted, because
  one release is ~460 MB), `release.yml` (pushing a `v*` tag publishes a real release with generated notes).
- The version in `package.json` is the single source of truth; the tag must match it.
- In-app updates use `electron-updater` over the **stable** channel only (`allowPrerelease = false`) — a
  nightly must never install itself overnight. `publish` in `electron-builder.yml` is what writes
  `latest.yml` and `resources/app-update.yml`; remove it and auto-update silently stops finding releases.
- `startUpdateCheck()` fires 8 s after launch and only when `app.isPackaged`; the panel turns the button into
  “重启并更新” once `status === "ready"`. Nothing restarts on its own — killing the app mid-match is worse
  than shipping the update a day late.
- Windows process checks: `tasklist /FI ... | grep` goes through the localized console and lies — `tail -2` cut it to nothing twice in one session and made a running app look dead, so an install killed a live training run. Ask PowerShell for a count instead:
  `powershell -NoProfile -Command "(Get-Process oh-my-dota2 -ErrorAction SilentlyContinue | Measure-Object).Count"` (0 = not running; Electron leaves several processes, so any count > 0 means running).
