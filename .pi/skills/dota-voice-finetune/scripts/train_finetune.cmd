@echo off
rem Sequential training: SoVITS(s2) then GPT(s1). Full GPU. ASCII only.
rem Before running: replace <hero> in build_train_configs.py output paths; set CONFIG_DIR to where tmp_s2.json/tmp_s1.yaml live.
cd /d D:\AI\GPT-SoVITS-v2pro-20250604
set PYTHONIOENCODING=utf-8
set PATH=D:\AI\GPT-SoVITS-v2pro-20250604\runtime;%PATH%
if not exist logs\mirana\logs_s2_v2 mkdir logs\mirana\logs_s2_v2
if not exist logs\mirana\logs_s1_v2 mkdir logs\mirana\logs_s1_v2
set _CUDA_VISIBLE_DEVICES=0
set hz=25hz

echo === TRAIN s2 SoVITS start ===
runtime\python.exe -s GPT_SoVITS/s2_train.py --config "%CONFIG_DIR%\tmp_s2.json"
if errorlevel 1 (echo S2_TRAIN_FAILED & exit /b 1)
echo === TRAIN s2 done ===

echo === TRAIN s1 GPT start ===
runtime\python.exe -s GPT_SoVITS/s1_train.py --config_file "%CONFIG_DIR%\tmp_s1.yaml"
if errorlevel 1 (echo S1_TRAIN_FAILED & exit /b 1)
echo === TRAIN s1 done ===

echo === TRAIN_ALL_DONE ===
dir /b SoVITS_weights_v2\*mirana* 2>nul
dir /b GPT_weights_v2\*mirana* 2>nul
