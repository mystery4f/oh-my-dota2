# -*- coding: utf-8 -*-
"""把 webui 分片产物合并成单文件（单卡时只有 part 0）。usage: merge_parts.py <opt_dir> <merged_name> <stem>"""
import os, sys, glob

opt_dir, merged_name, stem = sys.argv[1], sys.argv[2], sys.argv[3]
parts = sorted(glob.glob(os.path.join(opt_dir, stem + '-*.txt')) + glob.glob(os.path.join(opt_dir, stem + '-*.tsv')))
if not parts:
    print('no parts found for', stem)
    sys.exit(1)
out_lines = []
for p in parts:
    with open(p, encoding='utf8') as f:
        out_lines += [ln for ln in f.read().strip('\n').split('\n') if ln]
with open(os.path.join(opt_dir, merged_name), 'w', encoding='utf8') as f:
    f.write('\n'.join(out_lines) + '\n')
for p in parts:
    os.remove(p)
print(f'merged {len(parts)} parts -> {merged_name}: {len(out_lines)} lines')
