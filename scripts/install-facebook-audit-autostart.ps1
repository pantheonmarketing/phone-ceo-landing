$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $PSScriptRoot 'run-facebook-audit-worker.ps1'
$taskName = 'Phone CEO Facebook Audit Worker'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShellPath = (Get-Command 'powershell.exe' -ErrorAction Stop).Source

$actionArguments = @(
  '-NoProfile'
  '-NonInteractive'
  '-WindowStyle Hidden'
  '-ExecutionPolicy Bypass'
  '-File'
  ('"{0}"' -f $runnerPath)
) -join ' '

$action = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument $actionArguments `
  -WorkingDirectory $projectDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Runs the authorized Phone CEO Facebook audit worker at Windows login and restarts it after failures.' `
  -Force | Out-Null

$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$dashboardShortcutPath = Join-Path $desktopDirectory 'Facebook Audit Dashboard.url'
$dashboardShortcut = @(
  '[InternetShortcut]'
  'URL=http://127.0.0.1:4317/'
)
[System.IO.File]::WriteAllLines(
  $dashboardShortcutPath,
  $dashboardShortcut,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Output "AUTOSTART_TASK_INSTALLED=$taskName"
Write-Output "DASHBOARD_SHORTCUT_INSTALLED=$dashboardShortcutPath"
