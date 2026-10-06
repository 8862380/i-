@echo off
chcp 65001 >nul
title 停止内容数据监控台

echo 正在查找监听 8787 端口的采集服务...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  set FOUND=1
  echo 结束进程 PID %%P
  taskkill /PID %%P /F >nul 2>&1
)

if "%FOUND%"=="0" (
  echo 没有发现正在运行的服务（8787 端口空闲）。
) else (
  echo 已停止。
)
echo.
pause
