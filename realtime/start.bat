@echo off
chcp 65001 >nul
title 内容数据监控服务
cd /d "%~dp0"
set NODE_OPTIONS=--no-warnings
set OPEN_BROWSER=1

rem 找一个能用的 node（PATH → 常见安装位置 → Codex 自带运行时）
set "NODE_BIN="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_BIN=%%~$PATH:I"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_BIN (
  echo [错误] 没有找到 node.exe，请先安装 Node.js（https://nodejs.org，LTS 版本即可）。
  pause
  exit /b 1
)

rem 参数说明：
rem   start.bat            用 config.all.json 启动：B站作品 + 抖音热榜 + 快手热榜（免密钥真实数据）
rem   start.bat bilibili   只用 B站公开接口
rem   start.bat selftest   用 config.selftest.json 启动，并拉起自检数据源（联调用，假数据）

set CONFIG_FILE=config.all.json
if /i "%~1"=="bilibili" (
  set CONFIG_FILE=config.bilibili.json
)

if /i "%~1"=="selftest" (
  set CONFIG_FILE=config.selftest.json
  echo [%date% %time%] 启动自检数据源（假数据，仅用于联调）...
  start "selftest-feed" /min cmd /c ""%NODE_BIN%" "%~dp0tools\selftest.js""
  timeout /t 2 /nobreak >nul
)

:loop
echo [%date% %time%] 启动采集服务...
echo 看板地址： http://localhost:8787/   （服务就绪后会自动打开浏览器）
"%NODE_BIN%" "%~dp0server.js"
echo [%date% %time%] 服务已退出，5 秒后自动重启（关闭本窗口即可停止）
timeout /t 5 /nobreak >nul
goto loop
