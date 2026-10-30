@echo off
rem GPT-SoVITS v2 preprocessing driver (replicates webui env-var protocol). ASCII only.
rem Before running: replace <hero> with the hero internal name, set SKILL_SCRIPTS to this scripts dir.
cd /d D:\AI\GPT-SoVITS-v2pro-20250604
set PYTHONIOENCODING=utf-8
set PATH=D:\AI\GPT-SoVITS-v2pro-20250604\runtime;%PATH%
set inp_text=D:\AI\mirana-finetune\asr-out\cleaned.list
set inp_wav_dir=D:\AI\mirana-finetune\raw
set exp_name=mirana
set opt_dir=logs\mirana
set i_part=0
set all_parts=1
set _CUDA_VISIBLE_DEVICES=0
set is_half=True
set version=v2
set bert_pretrained_dir=GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large

echo === 1a get-text ===
runtime\python.exe -s GPT_SoVITS/prepare_datasets/1-get-text.py
if errorlevel 1 (echo 1A_FAILED & exit /b 1)
runtime\python.exe -X utf8 %SKILL_SCRIPTS%\merge_parts.py logs\mirana 2-name2text.txt 2-name2text
if errorlevel 1 (echo MERGE1_FAILED & exit /b 1)

set cnhubert_base_dir=GPT_SoVITS/pretrained_models/chinese-hubert-base
echo === 1b get-hubert-wav32k ===
runtime\python.exe -s GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py
if errorlevel 1 (echo 1B_FAILED & exit /b 1)

set pretrained_s2G=GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth
set s2config_path=GPT_SoVITS/configs/s2.json
echo === 1c get-semantic ===
runtime\python.exe -s GPT_SoVITS/prepare_datasets/3-get-semantic.py
if errorlevel 1 (echo 1C_FAILED & exit /b 1)
runtime\python.exe -X utf8 %SKILL_SCRIPTS%\merge_parts.py logs\mirana 6-name2semantic.tsv 6-name2semantic
if errorlevel 1 (echo MERGE2_FAILED & exit /b 1)

echo === PREP_ALL_DONE ===
runtime\python.exe -X utf8 -c "import os;d=r'logs\mirana';print('name2text lines:',sum(1 for _ in open(os.path.join(d,'2-name2text.txt'),encoding='utf8')));print('semantic lines:',sum(1 for _ in open(os.path.join(d,'6-name2semantic.tsv'),encoding='utf8')));print('wav32k count:',len(os.listdir(os.path.join(d,'5-wav32k'))))"
