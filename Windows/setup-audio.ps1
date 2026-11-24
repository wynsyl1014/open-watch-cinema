param([string]$DataRoot = $env:LOCAL_DATA_ROOT, [string]$Python, [switch]$Plan, [switch]$Yes, [switch]$UseUv)
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
$previousRoot = $env:LOCAL_DATA_ROOT
$previousBase = $env:OWC_AUDIO_BASE_PYTHON
try {
    if ($DataRoot) { $env:LOCAL_DATA_ROOT = $DataRoot }
    if ($Python) { $env:OWC_AUDIO_BASE_PYTHON = $Python }
    $options = @()
    if ($Plan) { $options += '--plan' }
    if ($Yes) { $options += '--yes' }
    if ($UseUv) { $options += '--uv' }
    & node scripts/preparation/setup.mjs audio @options
    exit $LASTEXITCODE
} finally {
    $env:LOCAL_DATA_ROOT = $previousRoot
    $env:OWC_AUDIO_BASE_PYTHON = $previousBase
    Pop-Location
}
