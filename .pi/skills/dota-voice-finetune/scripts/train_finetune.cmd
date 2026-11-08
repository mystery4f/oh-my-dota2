@echo off
rem Sequential training: SoVITS(s2) then GPT(s1). Full GPU. ASCII only.
rem Usage: train_finetune.cmd <exp_name> <config_dir>
rem   exp_name defaults to mirana, config_dir defaults to this script's folder.
rem Before running: build_train_configs.py must have written tmp_s2.json / tmp_s1.yaml
rem for that exp_name (the absolute paths inside them still need the hero substituted).
setlocal
set EXP_NAME=%~1
if "%EXP_NAME%"=="" set EXP_NAME=mirana
set CONFIG_DIR=%~2
if "%CONFIG_DIR%"=="" set CONFIG_DIR=%~dp0

rem An 8GB laptop card has no headroom: dota2.exe alone holds about 5.7GB, so training
rem either OOMs or crawls. Refuse to start instead of leaving a half-trained run behind.
rem Absolute System32 paths: a Git Bash PATH shadows tasklist/find with MSYS tools.
set SYS32=%SystemRoot%\System32
"%SYS32%\tasklist.exe" /FI "IMAGENAME eq dota2.exe" /NH 2>nul | "%SYS32%\findstr.exe" /I /C:"dota2.exe" >nul
if not errorlevel 1 (
  echo TRAIN_ABORTED dota2.exe is running - close the game first, it holds about 5.7GB VRAM
  exit /b 1
)

cd /d D:\AI\GPT-SoVITS-v2pro-20250604
set PYTHONIOENCODING=utf-8
set PATH=D:\AI\GPT-SoVITS-v2pro-20250604\runtime;%PATH%
if not exist logs\%EXP_NAME%\logs_s2_v2 mkdir logs\%EXP_NAME%\logs_s2_v2
if not exist logs\%EXP_NAME%\logs_s1_v2 mkdir logs\%EXP_NAME%\logs_s1_v2
set _CUDA_VISIBLE_DEVICES=0
set hz=25hz

echo === TRAIN %EXP_NAME% s2 SoVITS start ===
runtime\python.exe -s GPT_SoVITS/s2_train.py --config "%CONFIG_DIR%\tmp_s2.json"
if errorlevel 1 (echo S2_TRAIN_FAILED & exit /b 1)
echo === TRAIN s2 done ===

echo === TRAIN %EXP_NAME% s1 GPT start ===
runtime\python.exe -s GPT_SoVITS/s1_train.py --config_file "%CONFIG_DIR%\tmp_s1.yaml"
if errorlevel 1 (echo S1_TRAIN_FAILED & exit /b 1)
echo === TRAIN s1 done ===

echo === TRAIN_ALL_DONE %EXP_NAME% ===
dir /b SoVITS_weights_v2\%EXP_NAME%* 2>nul
dir /b GPT_weights_v2\%EXP_NAME%* 2>nul
