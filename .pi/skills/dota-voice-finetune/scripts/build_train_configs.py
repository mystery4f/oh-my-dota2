# -*- coding: utf-8 -*-
"""生成 s2/s1 训练配置（复刻 webui open1Ba/open1Bb 的字段写入），输出到 .tmp/。"""
import json, yaml, os

PKG = r'D:\AI\GPT-SoVITS-v2pro-20250604'
TMP_DIR = r'D:\work\Code\Game\oh-my-dota2-v3\.tmp'  # where tmp_s2.json/tmp_s1.yaml land; train cmd reads CONFIG_DIR
OUT_DIR = os.path.join(PKG, 'logs', 'mirana')
PRE = 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained'

# ---- s2 (SoVITS) ----
with open(os.path.join(PKG, 'GPT_SoVITS', 'configs', 's2.json'), encoding='utf8') as f:
    data = json.load(f)
t = data['train']
t['batch_size'] = 5
t['epochs'] = 8
t['text_low_lr_rate'] = 0.4
t['pretrained_s2G'] = f'{PRE}/s2G2333k.pth'
t['pretrained_s2D'] = f'{PRE}/s2D2333k.pth'
t['if_save_latest'] = True
t['if_save_every_weights'] = True
t['save_every_epoch'] = 4
t['gpu_numbers'] = '0,'
t['grad_ckpt'] = True
data['model']['version'] = 'v2'
data['data']['exp_dir'] = data['s2_ckpt_dir'] = 'logs/mirana'
data['save_weight_dir'] = 'SoVITS_weights_v2'
data['name'] = 'mirana'
data['version'] = 'v2'
with open(TMP_DIR + '\\tmp_s2.json', 'w', encoding='utf8') as f:
    json.dump(data, f, ensure_ascii=False, indent=1)

# ---- s1 (GPT) ----
with open(os.path.join(PKG, 'GPT_SoVITS', 'configs', 's1longer-v2.yaml'), encoding='utf8') as f:
    y = yaml.safe_load(f)
yt = y['train']
yt['batch_size'] = 6
yt['epochs'] = 15
yt['save_every_n_epoch'] = 5
yt['if_save_latest'] = True
yt['if_save_every_weights'] = True
yt['if_dpo'] = False
yt['half_weights_save_dir'] = 'GPT_weights_v2'
yt['exp_name'] = 'mirana'
y['pretrained_s1'] = f'{PRE}/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'
y['train_semantic_path'] = f'{OUT_DIR}\\6-name2semantic.tsv'
y['train_phoneme_path'] = f'{OUT_DIR}\\2-name2text.txt'
y['output_dir'] = f'{OUT_DIR}\\logs_s1_v2'
with open(TMP_DIR + '\\tmp_s1.yaml', 'w', encoding='utf8') as f:
    yaml.safe_dump(y, f, allow_unicode=True, sort_keys=False)

print('configs written: tmp_s2.json / tmp_s1.yaml')
print('s2 bs=5 epochs=8 grad_ckpt=True | s1 bs=6 epochs=15')
