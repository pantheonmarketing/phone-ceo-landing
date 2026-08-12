$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$dashboardUrl = 'http://127.0.0.1:4317/'

# Sensitive Telegram values are stored in the current Windows user's private
# environment because Vercel does not export sensitive values back to .env.local.
foreach ($settingName in @('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID')) {
  $settingValue = [Environment]::GetEnvironmentVariable($settingName, 'User')
  if (-not [string]::IsNullOrWhiteSpace($settingValue)) {
    Set-Item -Path "Env:$settingName" -Value $settingValue
  }
}

try {
  Invoke-WebRequest -UseBasicParsing -Uri "${dashboardUrl}api/worker" -TimeoutSec 1 | Out-Null
  Start-Process $dashboardUrl
  exit 0
} catch {
  # The agent is not running yet.
}

$dataDirectory = Join-Path $projectDirectory 'data'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$stdoutPath = Join-Path $dataDirectory 'facebook-audit-worker.log'
$stderrPath = Join-Path $dataDirectory 'facebook-audit-worker-error.log'

Start-Process -FilePath 'node.exe' `
  -ArgumentList 'worker/facebook-audit-worker.js' `
  -WorkingDirectory $projectDirectory `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "${dashboardUrl}api/worker" -TimeoutSec 1 | Out-Null
    Start-Process $dashboardUrl
    exit 0
  } catch {
    # Keep waiting while the private queue connects.
  }
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
  "The Audit Agent could not start. Send Codex the file:`n$stderrPath",
  'Facebook Audit Agent'
) | Out-Null
exit 1
