$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectDirectory 'data'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null

foreach ($settingName in @('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID')) {
  $settingValue = [Environment]::GetEnvironmentVariable($settingName, 'User')
  if (-not [string]::IsNullOrWhiteSpace($settingValue)) {
    Set-Item -Path "Env:$settingName" -Value $settingValue
  }
}

$stdoutPath = Join-Path $dataDirectory 'facebook-audit-worker.log'
$stderrPath = Join-Path $dataDirectory 'facebook-audit-worker-error.log'

Push-Location $projectDirectory
try {
  & node.exe 'worker/facebook-audit-worker.js' 1>> $stdoutPath 2>> $stderrPath
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
