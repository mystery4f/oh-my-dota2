# -*- coding: utf-8 -*-
"""清洗 funasr 转写：游戏配音自带混响尾巴，ASR 把尾音写成重复词。
两条规则 + 已知官方文本兜底，输出 cleaned.list（无标点）。米拉娜专用。"""
import re, sys

RAW = r'D:\AI\mirana-finetune\asr-out\raw.list'
OUT = r'D:\AI\mirana-finetune\asr-out\cleaned.list'
REPORT = r'D:\AI\mirana-finetune\asr-out\clean-report.txt'

# 官方逐字文本兜底（ASR 明显错字时人工修正，人格套，转写后按 report 填）
GT = {
    # 人格套 GT 兜底：转写后按 report 填，只修确认错字，宁可错杀
}

# 发音级专名统一（不追求官方字面，只要求全数据集拼法一致、发音贴音频）
TEXT_FIX = {
    '赛根': '萨根', '塞丹': '萨根', '三根': '萨根', '赛哥': '萨根',  # 坐骑 Sagan
    '赛利蒙尼': '赛莉蒙妮', '塞利蒙尼': '赛莉蒙妮',  # Selemene
    '马西': '玛西',  # Marci
    '达威安': '达维安', '大维安': '达维安',  # Davion
    '银业森林': '银夜森林', '营业森林': '银夜森林',  # persona 故乡
    '太阳地拳': '太阳帝权', '太阳地权': '太阳帝权',  # persona 帝国
    '菲木林': '菲姆林',
    '瞄准钟': '瞄准中',  # 同一名字两种听写，统一拼法
}
# ASR 整句乱码且无法确认台词 → 丢弃
DROP = {
    'mira_per_ally_003',   # 赫扎格：人名存疑整句不可靠
    'mira_per_deny_03',    # 反哺：语义不明
    'mira_per_kill_03',    # 郑重把心：乱码
    'mira_per_levelup_06', # 星球古龙之眼：物品名乱码
    'mira_per_rival_014',  # 霍乱：语义不明
}

def strip_punct(s):
    return re.sub(r'[，。？！,.?!~…—\s]+', '', s)

def dedupe(t):
    """尾部回声：t[:-k].endswith(t[-k:]) → 删尾部 k 字；再扫一遍串内 BB→B。"""
    changed = True
    while changed:
        changed = False
        for k in range(8, 1, -1):
            if len(t) > 2 * k and t[:-k].endswith(t[-k:]):
                t = t[:-k]; changed = True; break
        if changed:
            continue
        for k in range(8, 1, -1):
            for j in range(len(t) - 2 * k + 1):
                if t[j:j+k] == t[j+k:j+2*k]:
                    t = t[:j+k] + t[j+2*k:]
                    changed = True
                    break
            if changed:
                break
    return t

lines_out, report = [], []
n_gt, n_cleaned, n_untouched = 0, 0, 0
for line in open(RAW, encoding='utf-8'):
    line = line.strip()
    if not line:
        continue
    path, spk, lang, text = line.split('|')
    key = re.sub(r'\.(wav|mp3|flac)$', '', path.replace('\\', '/').split('/')[-1])
    raw_nop = strip_punct(text)
    if key in GT:
        fixed = GT[key]
        report.append(f'[GT ] {key}\n  asr : {raw_nop}\n  gt  : {fixed}')
        n_gt += 1
    else:
        fixed = dedupe(raw_nop)
        for a, b in TEXT_FIX.items():
            fixed = fixed.replace(a, b)
        if key in DROP:
            fixed = ''
        if fixed != raw_nop:
            report.append(f'[CLE] {key}\n  raw : {raw_nop}\n  fix : {fixed}')
            n_cleaned += 1
        else:
            n_untouched += 1
    if len(fixed) >= 2:
        lines_out.append(f'{path}|mirana|ZH|{fixed}')

open(OUT, 'w', encoding='utf-8').write('\n'.join(lines_out) + '\n')
open(REPORT, 'w', encoding='utf-8').write('\n'.join(report) + f'\n\ngt={n_gt} cleaned={n_cleaned} untouched={n_untouched} total_out={len(lines_out)}\n')
print(f'gt={n_gt} cleaned={n_cleaned} untouched={n_untouched} total_out={len(lines_out)}')
