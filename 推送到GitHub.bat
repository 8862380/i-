@echo off
chcp 65001 >nul
title 推送监控台到 GitHub
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo [错误] 没有找到 git，请先安装 Git：https://git-scm.com/download/win
  echo        安装时保持默认选项，装完重新双击本文件。
  pause
  exit /b 1
)

echo ============================================
echo   把本目录推到你的 GitHub 仓库
echo ============================================
echo.
echo 先在 GitHub 上新建一个仓库（不要勾选 Add README），
echo 然后把它给你的地址粘贴到下面。
echo.
set /p REPO=仓库地址（形如 https://github.com/用户名/仓库.git）:
if "%REPO%"=="" (
  echo 没有输入地址，已取消。
  pause
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo 初始化仓库...
  git init
)

git config user.name >nul 2>&1
if errorlevel 1 set "NEED_NAME=1"
if defined NEED_NAME (
  set /p GITNAME=请输入提交用的名字（随便填，例如你的昵称）:
  set /p GITMAIL=请输入提交用的邮箱（例如 你的用户名@users.noreply.github.com）:
  git config user.name "%GITNAME%"
  git config user.email "%GITMAIL%"
)

echo.
echo 添加文件并提交...
git add -A
git commit -m "更新：内容数据监控台（采集数据 + 分析看板）" 2>nul
git branch -M main

git remote remove origin >nul 2>&1
git remote add origin "%REPO%"

echo.
echo 正在推送（第一次会要求登录 GitHub，按提示授权即可）...
git push -u origin main

echo.
if errorlevel 1 (
  echo [推送失败] 常见原因：地址填错、没有登录/授权、或者远程仓库里已经有内容需要先 pull。
  echo          把上面的报错发我，我帮你看。
) else (
  echo [推送成功] 接下来在 GitHub 仓库里做两件事：
  echo   1. Settings → Actions → General → Workflow permissions 选 Read and write permissions
  echo   2. Settings → Pages → Deploy from a branch → main → / (root)
  echo   然后到 Actions 页面点一次「Run workflow」，等 1-2 分钟就能打开你的网址了。
)
echo.
pause
