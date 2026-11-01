"""IndexTTS-2.5 zero-shot POC benchmark for oh-my-dota2.

Synthesizes a fixed zh+en line list from one reference clip, measures cold/warm
per-sentence latency and VRAM, runs a consecutive success pass, and writes a
markdown report next to the generated wavs.

Run from an index-tts repo checkout with its venv (see README.md):

    python poc_bench.py --model-dir <weights> --ref <clip.wav> \
        --ref-text "<transcript>" --out <report-dir> [--smoke]
"""
import argparse
import json
import statistics
import subprocess
import time
import wave
from pathlib import Path

ZH_LINES = [
    "中路集合，推完一塔再一起游走。",
    "打野注意看符点，两分钟有赏金符。",
    "别送，稳住，等大招转好再打。",
    "下路需要支援，我来插个眼。",
    "这波不亏，下一波集合抓人。",
    "买活别急，留着打高地团。",
    "他们五个消失了，小心河道。",
    "兵线不要太深，先撤回来。",
    "肉山刷新了，做个视野再打。",
    "打得不错，这把稳了。",
]
EN_LINES = [
    "Group up mid, we take the tower then rotate bot.",
    "Watch the rune spot, bounty spawns in two minutes.",
    "Do not feed, hold on until our ultimates are ready.",
    "Bot lane needs help, I will place a ward there.",
    "That fight was fine, group up and gank next wave.",
    "Do not buy back yet, save it for the high ground fight.",
    "All five of them are missing, be careful near the river.",
    "The creep wave is too deep, pull back for now.",
    "Roshan is up, let us get vision before we fight.",
    "Well played, this game is in the bag.",
]


def wav_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / max(w.getframerate(), 1)
    except Exception:
        return -1.0


def smi_vram_mib():
    """Return (used_MiB, total_MiB) of the first GPU from nvidia-smi, or (0, 0)."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()[0]
        used, total = (int(x.strip()) for x in out.split(","))
        return used, total
    except Exception:  # pragma: no cover - diagnostic only
        return 0, 0

def main() -> None:
    ap = argparse.ArgumentParser(description="IndexTTS-2.5 zero-shot POC benchmark")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--ref", required=True, help="reference clip (wav/mp3)")
    ap.add_argument("--ref-text", required=True, help="verbatim transcript of the reference clip")
    ap.add_argument("--out", required=True, help="report + wav output directory")
    ap.add_argument("--smoke", action="store_true", help="only the first zh + en line, no verdict")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    import torch
    from indextts.infer_v2_5 import IndexTTS2

    lines = list(zip(ZH_LINES, EN_LINES))
    if args.smoke:
        lines = lines[:1]

    t0 = time.perf_counter()
    tts = IndexTTS2(cfg_path=str(Path(args.model_dir) / "config.yaml"), model_dir=args.model_dir)
    load_ms = (time.perf_counter() - t0) * 1000

    rows = []
    fail = []
    for i, (zh, en) in enumerate(lines):
        for tag, text in (("zh", zh), ("en", en)):
            wav_path = out / f"line{i:02d}_{tag}.wav"
            t1 = time.perf_counter()
            try:
                tts.infer(spk_audio_prompt=args.ref, text=text, output_path=str(wav_path), lang=tag, verbose=False)
                ms = (time.perf_counter() - t1) * 1000
                secs = wav_seconds(wav_path)
                ok = secs > 0.5
                rows.append({"line": i, "tag": tag, "ms": round(ms), "wav_s": round(secs, 2), "ok": ok})
                print(f"line{i:02d} {tag}: {ms:.0f} ms, {secs:.2f} s audio, ok={ok}")
            except Exception as e:
                fail.append({"line": i, "tag": tag, "error": repr(e)})
                print(f"line{i:02d} {tag}: FAILED {e!r}")

    good = [r["ms"] for r in rows if r["ok"]]
    total_used, total_max = smi_vram_mib()
    cuda_peak = torch.cuda.max_memory_allocated() / 2**30 if torch.cuda.is_available() else 0.0
    p50 = statistics.median(good) if good else 0
    verdict = "SMOKE" if args.smoke else ("PASS" if len(good) >= 18 and p50 < 3000 else "FAIL")

    report = {
        "verdict": verdict,
        "load_ms": round(load_ms),
        "p50_ms": round(p50),
        "min_ms": min(good) if good else 0,
        "max_ms": max(good) if good else 0,
        "success": f"{len(good)}/{len(rows)}",
        "cuda_peak_GiB": round(cuda_peak, 2),
        "vram_used_total_MiB": f"{total_used} used / {total_max} total",
        "failures": fail,
        "rows": rows,
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    md = ["# IndexTTS-2.5 POC report", "",
          f"- verdict: **{verdict}** (budget: warm p50 < 3000 ms and >= 18/20)",
          f"- model load: {load_ms:.0f} ms",
          f"- warm synth p50/min/max: {p50:.0f} / {min(good) if good else 0:.0f} / {max(good) if good else 0:.0f} ms",
          f"- success: {len(good)}/{len(rows)}",
          f"- cuda peak allocated: {cuda_peak:.2f} GiB",
          f"- nvidia-smi: {total_used} MiB used / {total_max} MiB total",
          "", "| line | lang | ms | audio s | ok |", "|---|---|---|---|---|"]
    md += [f"| {r['line']:02d} | {r['tag']} | {r['ms']} | {r['wav_s']} | {r['ok']} |" for r in rows]
    if fail:
        md += ["", "## failures"] + [f"- {f}" for f in fail]
    (out / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("verdict", "load_ms", "p50_ms", "success", "cuda_peak_GiB")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
