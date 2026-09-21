[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

& node 'scripts/repository-boundary.mjs'
if ($LASTEXITCODE -ne 0) {
  throw 'Repository boundary verification failed.'
}

if (-not (Test-Path -LiteralPath '.env.local' -PathType Leaf)) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
  Write-Host 'Created untracked .env.local from .env.example.'
} else {
  Write-Host 'Preserved existing .env.local.'
}

$pnpmCommand = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'pnpm.cmd' } else { 'pnpm' }
& $pnpmCommand install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  throw "Dependency installation failed with exit code $LASTEXITCODE."
}

Write-Host 'BEA_PHASE0_BOOTSTRAP=PASS'
