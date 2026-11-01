# IndexTTS-2.5 POC benchmark

App-external proof of concept for the zero-shot reading engine (spec issue #17, ticket #18).
The benchmark script is versioned here; model weights and the Python environment stay OUTSIDE
the repo in a dev-only directory (`--model-dir`, no repo code references that path).

## Prerequisites

- index-tts repo checkout (github.com/index-tts/index-tts) with its own venv:
  `uv venv --python 3.11 .venv` then `uv sync --frozen --no-install-package torch --no-install-package torchaudio`
- GPU torch: `uv pip install "torch==2.8.0+cu128" "torchaudio==2.8.0+cu128" --find-links https://mirrors.aliyun.com/pytorch-wheels/cu128/ --index-url https://mirrors.aliyun.com/pypi/simple/`
- weights from ModelScope `IndexTeam/IndexTTS-2.5` (config.yaml + gpt.pth + codec.pth +
  s2mel.pth + qwen0.6bemo4-merge/ + feat1.pt + feat2.pt + tiktoken + wav2vec2bert_stats.pt)

## Run

```sh
cd <index-tts checkout>
./.venv/Scripts/python.exe <repo>/scripts/poc-indextts/poc_bench.py \
  --model-dir <weights dir> \
  --ref <reference clip, 3-10 s> --ref-text "<verbatim transcript>" \
  --out <report dir>            # add --smoke for a 2-line sanity pass
```

Verdict line prints PASS/FAIL/SMOKE; budget: warm p50 < 3000 ms and >= 18/20 clean sentences.
