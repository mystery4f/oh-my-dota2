# -*- coding: utf-8 -*-
"""funasr(paraformer) 本地转写：把一目录的 wav/mp3 转成 raw.list（path|spk|ZH|text）。

用法（必须用整合包 runtime 的 python，funasr 装在那里）：
  runtime\\python.exe -X utf8 asr_transcribe.py <audio_dir> <out.list> [speaker]

- 模型 paraformer-zh 首次运行会自动下载到 %USERPROFILE%\\.cache（已下载过则离线可用）
- 纯笑声/无语音条目会得到空文本，转写后由 clean_asr 过滤
"""
import os
import sys


def main() -> None:
    if len(sys.argv) < 3:
        print('usage: asr_transcribe.py <audio_dir> <out.list> [speaker]')
        sys.exit(1)
    audio_dir, out_list = sys.argv[1], sys.argv[2]
    speaker = sys.argv[3] if len(sys.argv) > 3 else 'raw'

    from funasr import AutoModel

    model = AutoModel(model='paraformer-zh', disable_update=True)
    exts = ('.wav', '.mp3', '.flac')
    names = sorted(n for n in os.listdir(audio_dir) if n.lower().endswith(exts))
    rows = []
    for i, name in enumerate(names, 1):
        path = os.path.join(audio_dir, name)
        try:
            res = model.generate(input=path)
            text = (res[0].get('text', '') or '').strip() if res else ''
        except Exception as err:  # noqa: BLE001 - 单条失败不中断整批
            print(f'[{i}/{len(names)}] {name} ERROR {err}')
            text = ''
        rows.append(f'{path}|{speaker}|ZH|{text}')
        print(f'[{i}/{len(names)}] {name} -> {text!r}')
    with open(out_list, 'w', encoding='utf-8') as f:
        f.write('\n'.join(rows) + '\n')
    print(f'DONE {len(rows)} rows -> {out_list}')


if __name__ == '__main__':
    main()
