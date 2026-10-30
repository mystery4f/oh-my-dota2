# 风行者至宝实战参数（参考基线）

## 数据集
- 来源：D:/AI/ohmydota2-ref/windranger-arcana-set/（64 条简中配音 mp3，Source2Viewer 从 dota_schinese vpk 导出）
- 分组前缀：wr_arc_spawn / wr_arc_intro / wr_arc_wheel_all / wr_arc_level / wr_arc_laugh
- 入选 58 条 = 64 - 2 条纯笑声 ASR 空 - 3 条清洗后过短；2 条语音轮盘用官方转写兜底
- cleaned.list 格式：`D:\AI\windranger-finetune\raw\xxx.wav|windranger|ZH|无标点文本`

## 训练配置（4060 Laptop 8GB 实测）
- s2 (SoVITS)：bs=5，epochs=8，grad_ckpt=True，text_low_lr_rate=0.4，底座 gsv-v2final-pretrained/s2G2333k.pth + s2D2333k.pth，save_every_epoch=4
- s1 (GPT)：bs=6，epochs=15，save_every_n_epoch=5，底座 s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt，if_dpo=False
- 速度：1.25-1.4s/步，全程 ~10 分钟；显存 7.4GB 贴上限但稳
- 预处理：58 对 text/hubert/semantic 全对齐（logs/<exp>/ 下 2-name2text.txt、5-wav32k/、6-name2semantic.tsv）

## 产物与切换
- SoVITS_weights_v2/windranger_e8_s192.pth + GPT_weights_v2/windranger-e15.ckpt（中间档 e4/e5/e10）
- tts_infer.yaml custom 段：version v2，device cuda，is_half true
- 微调后实测：23 字 → 4.70s 音频 / 1.6s 往返（零样本跨参考时 6.4-7.3s，语速差一倍）

## 米拉娜差异提示
- 内部名 mirana；pak01_dir.vpk 的 sounds/vo/mirana/ 是英文原声，简中配音同样在 dota_schinese vpk
- 米拉娜语音量大（含至宝前更多），全部收集可能 100+ 条：够 60-80 条即可，优先短句（3-10s）
- 台词参考：Dota Wiki Mirana Responses 页（MediaWiki api.php）
