$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot

try {
  Start-Process -FilePath 'node.exe' `
    -ArgumentList 'worker/facebook-login.js' `
    -WorkingDirectory $projectDirectory `
    -WindowStyle Hidden `
    -Wait
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    'The dedicated Facebook login could not open. Ask Codex to inspect the Audit Agent.',
    'Facebook Audit Account'
  ) | Out-Null
  exit 1
}
