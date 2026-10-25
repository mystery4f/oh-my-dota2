# oh-my-dota2

Zero-injection Dota 2 teammate communication tool (Electron + React).

Communicate with foreign teammates without touching the game process:

- **Chat translation** — read the in-game chat through Dota 2 Game State Integration, translate via a configurable LLM provider, show a bilingual transparent overlay. Replies are translated and copied to the clipboard for in-game paste.
- **Read-aloud** — speak each translation: Edge neural voices (default, ~1.2 s per line), a local Matcha model (76 MB, on-demand download, 111–249 ms, offline), or the system voice.
- **Voice translation** (skeleton) — capture teammate voice via system loopback, transcribe locally with whisper.cpp.
- **Mic language conversion** (skeleton) — speak Chinese, teammates hear English: mic, whisper.cpp, translation, TTS into a virtual audio cable.

## Read-aloud engines

- **Edge neural voices (default)** — natural, no key, but every line is a cross-border round trip (p50 1.2 s).
- **Local model (Matcha, Chinese)** — 76 MB downloaded on demand into the portable data dir, p50 111-249 ms, fully offline. The dataset is licensed for non-commercial use only, and it needs a real node on PATH: the native addon refuses to run inside any Electron runtime.
- **System voice** — always available, robotic.

## Principles

- Zero game injection (VAC-safe): GSI + clipboard only, no memory reads, no synthetic input.
- Provider-agnostic: any OpenAI-compatible endpoint (DeepSeek by default, OpenAI, Ollama, custom).

## Development

```bash
npm install
npm run dev        # electron-vite dev
npm run typecheck
npm run build
```

Requires Node 20+, Windows 10/11 (Windows.Media.Ocr).

## Roadmap

- [x] M1 scaffold: settings dashboard, provider layer
- [x] M2 chat capture: in-game region picker, PaddleOCR, dedupe, transparent overlay
- [x] M3 reply flow: zh→en translation with clipboard handoff (panel + overlay bar)
- [x] M4 voice skeletons: whisper.cpp probe, TTS preview
- [x] M5 everyday use: tray resident, auto-start capture, overview self-check, own-line filter
- [x] M6 voice pipeline: whisper.cpp assets, mic capture with Alt+Shift+V, msedge-tts preview
- [x] M7 chat quality: block translation with history, scroll dedupe, short reply with tone presets, panel and overlay reply drafts

See [docs/DESIGN.md](docs/DESIGN.md) and [docs/PLAN.md](docs/PLAN.md).
