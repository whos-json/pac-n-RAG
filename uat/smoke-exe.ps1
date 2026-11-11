# Smoke test for the desktop app. Starts it on a throwaway data folder, checks it stays up and created its
# data folder, then stops it.
#   powershell -File uat\smoke-exe.ps1            test the packaged dist\win-unpacked\PAC-RAG.exe
#   powershell -File uat\smoke-exe.ps1 -Dev       test the same code through node_modules\electron
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$d = Join-Path $env:TEMP 'pacrag-smoke'
Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
$env:DATA_DIR = $d
try {
  if ($Dev) { $p = Start-Process -FilePath (Join-Path $root 'node_modules\electron\dist\electron.exe') -ArgumentList ('"' + $root + '"') -PassThru }
  else { $p = Start-Process -FilePath (Join-Path $root 'dist\win-unpacked\PAC-RAG.exe') -PassThru }
} catch { "FAILED to launch: $($_.Exception.Message)"; exit 2 }
Start-Sleep 12
$alive = -not $p.HasExited
"running: $alive"
"data folder contents: " + ((Get-ChildItem $d -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', ')
Get-Process -Name PAC-RAG, electron -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
if (-not $alive) { exit 1 }
