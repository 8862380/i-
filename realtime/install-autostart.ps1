param(
  [ValidateSet('Install', 'Uninstall', 'Status')]
  [string]$Action = 'Install',
  [string]$TaskName = 'MediaMonitor',
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $here 'start.bat'

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

switch ($Action) {
  'Install' {
    $node = Get-NodePath
    if (-not $node) { Write-Warning 'PATH 里没有找到 node，请先安装 Node.js 18+（建议 22+，内置 sqlite）。' }
    else { Write-Host "使用 Node: $node" }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$bat'`"" `
      -WorkingDirectory $here
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
      -Settings $settings -Principal $principal `
      -Description '内容数据监控：开机自动拉起采集服务，崩溃后每分钟自动重启。' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "已安装开机自启任务「$TaskName」，并已启动。看板地址： http://localhost:$Port/"
    Write-Host "查看状态： powershell -File install-autostart.ps1 -Action Status"
    Write-Host "卸载：     powershell -File install-autostart.ps1 -Action Uninstall"
  }
  'Uninstall' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已卸载任务「$TaskName」。"
  }
  'Status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "任务「$TaskName」未安装。"; break }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $task | Select-Object TaskName, State | Format-List
    $info | Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns | Format-List
  }
}
