param([string]$DataRoot = $env:LOCAL_DATA_ROOT, [string]$Python)
$ErrorActionPreference = 'Stop'
if (-not $DataRoot) { $DataRoot = Join-Path $PSScriptRoot 'local-data' }
$audioEnvironment = Join-Path $PSScriptRoot 'observer/.conette-venv'
$audioPython = Join-Path $audioEnvironment 'Scripts/python.exe'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'Install uv from https://docs.astral.sh/uv/getting-started/installation/ then run setup-audio.ps1 again.'
}
if (-not (Test-Path -LiteralPath $audioPython)) {
    if ($Python) { & $Python -m venv $audioEnvironment }
    else { & uv venv --python 3.10 $audioEnvironment }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the private audio environment.' }
}
& $audioPython (Join-Path $PSScriptRoot 'scripts/normalize-audio-venv.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not normalize the audio Python runtime path.' }
Write-Host 'Installing the local audio runtime (CPU build)...'
& uv pip install --python $audioPython torch==1.13.1 torchaudio==0.13.1 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'Audio runtime installation failed.' }
& uv pip install --python $audioPython -r (Join-Path $PSScriptRoot 'observer/audio-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Audio dependencies could not be installed.' }
Write-Host 'Downloading the public audio model. This downloads the CoNeTTE checkpoint; movie audio stays local.'
& $audioPython (Join-Path $PSScriptRoot 'scripts/download-audio-model.py') --data-root $DataRoot
if ($LASTEXITCODE -ne 0) { throw 'Audio model download failed; rerun to resume.' }
Write-Host 'Audio setup finished. No inference or live test was run. Use Add audio descriptions in the cinema.'
