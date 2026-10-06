@echo off
chcp 65001 >nul
title 内容数据监控台（关闭本窗口即停止服务）
cd /d "%~dp0"
set NODE_OPTIONS=--no-warnings
set OPEN_BROWSER=1

echo ============================================
echo   内容数据监控台  正在启动
echo ============================================
echo.

rem ---------- 1. 找一个能用的 node ----------
set "NODE_BIN="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_BIN=%%~$PATH:I"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_BIN (
  echo [错误] 没有找到 node.exe，采集服务需要 Node.js 才能运行。
  echo.
  echo  解决办法：到 https://nodejs.org 下载安装 Node.js（LTS 版本即可），
  echo  安装时保持默认选项，装完重新双击本文件就行。
  echo.
  pause
  exit /b 1
)
echo   Node 程序： %NODE_BIN%

rem ---------- 2. 选配置：优先用你自己配的真实数据源 ----------
set "CONFIG_FILE="
if exist "realtime\config.json" (
  set CONFIG_FILE=config.json
  echo   数据源：   realtime\config.json（你自己配置的接口）
) else (
  set CONFIG_FILE=config.all.json
  echo   数据源：   B站作品 + 抖音热榜 + 快手热榜（免密钥真实数据）
  echo   提示：     想接自己的授权接口（例如抖音开放平台的作品数据），把
  echo              realtime\config.example.json 复制成 realtime\config.json
  echo              并填好密钥，再重新双击本文件。
)
echo.
echo   看板地址： http://localhost:8787/
echo   （服务就绪后浏览器会自动打开；本窗口不要关，关了服务就停了）
echo ============================================
echo.

cd realtime
"%NODE_BIN%" server.js

echo.
echo [服务已退出] 如果是意外退出，上面通常会有报错信息。
echo   常见原因：端口被占用、接口地址填错、网络不通。
echo   也可以查看日志： realtime\data\logs\
echo.
pause
