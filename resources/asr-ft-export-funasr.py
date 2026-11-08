"""Export a fine-tuned FunASR paraformer to ONNX in the shape sherpa-onnx expects.

FunASR's own exporter only writes `model.onnx` / `model_quant.onnx`. sherpa-onnx's
OfflineParaformerModel additionally needs

  * `tokens.txt` next to the model (one `<token> <id>` per line), and
  * metadata on the graph: vocab_size, lfr_window_size, lfr_window_shift, neg_mean,
    inv_stddev, model_type -- without vocab_size it refuses to load the file at all
    ("'vocab_size' does not exist in the metadata").

Both are derivable from the base model directory (tokens.json + am.mvn), so this script
does export + post-processing in one process. Passing the run directory as `--base` is
wrong: AutoModel then reads the training config and exports a half-initialized graph
(measured: 625 of 955 initializers, garbage output). Always pass the base model id or
directory, and the checkpoint weights through --init-param.

Usage:
  python asr-ft-export-funasr.py --base <model id | dir> --init-param <ckpt>/model.pt \
      --output-dir <dir> [--no-quantize]
"""

import argparse
import json
import os
import sys


def base_dir_of(base: str) -> str:
    """Map a ModelScope id like org/name to its cache directory."""
    if os.path.isdir(base):
        return base
    cache = os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub", "models")
    return os.path.join(cache, *base.split("/"))


def read_cmvn(path: str) -> tuple[str, str]:
    text = open(path, encoding="utf-8").read()

    def block(name: str) -> str:
        marker = f"<{name}> 560 560"
        start = text.index("[", text.index(marker) + len(marker)) + 1
        return ",".join(text[start : text.index("]", start)].split()[:560])

    return block("AddShift"), block("Rescale")


def write_tokens(base_dir: str, tokens_out: str) -> int:
    tokens = json.load(open(os.path.join(base_dir, "tokens.json"), encoding="utf-8"))
    with open(tokens_out, "w", encoding="utf-8", newline="\n") as handle:
        for index, token in enumerate(tokens):
            handle.write(f"{token} {index}\n")
    return len(tokens)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, help="base model id or directory")
    parser.add_argument("--init-param", required=True, help="checkpoint weights file (model.pt)")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--no-quantize", action="store_true")
    args = parser.parse_args()

    import onnx
    from funasr import AutoModel

    out = os.path.abspath(args.output_dir)
    os.makedirs(out, exist_ok=True)

    model = AutoModel(
        model=args.base,
        init_param=args.init_param,
        output_dir=out,
        device="cpu",
        disable_update=True,
    )
    model.export(
        input=None,
        type="onnx",
        quantize=not args.no_quantize,
        fallback_num=5,
        calib_num=100,
        opset_version=14,
    )

    base_dir = base_dir_of(args.base)
    f32 = os.path.join(out, "model.onnx")
    quantized = os.path.join(out, "model_quant.onnx")
    source = f32 if args.no_quantize or not os.path.isfile(quantized) else quantized
    target = os.path.join(out, "model.int8.onnx")

    vocab = write_tokens(base_dir, os.path.join(out, "tokens.txt"))
    neg_mean, inv_stddev = read_cmvn(os.path.join(base_dir, "am.mvn"))

    graph = onnx.load(source, load_external_data=False)
    del graph.metadata_props[:]
    for key, value in [
        ("model_type", "paraformer"),
        ("version", "1"),
        ("vocab_size", str(vocab)),
        ("lfr_window_size", "7"),
        ("lfr_window_shift", "6"),
        ("neg_mean", neg_mean),
        ("inv_stddev", inv_stddev),
    ]:
        entry = graph.metadata_props.add()
        entry.key = key
        entry.value = value
    onnx.save(graph, target)

    if os.path.abspath(source) != os.path.abspath(target):
        os.remove(source)
    print(f"ASR_FT_EXPORT_OK {target} vocab={vocab}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
