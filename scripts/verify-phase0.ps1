[CmdletBinding()]
param(
  [switch]$SkipEndToEnd
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
$pnpmCommand = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'pnpm.cmd' } else { 'pnpm' }

$verificationEnvironment = @{
  APP_MODE = 'demo'
  APP_BASE_URL = 'http://127.0.0.1:3000'
  DATABASE_DRIVER = 'pglite'
  DEMO_DATABASE_PATH = '.data/phase0-verification'
  WORKER_DEMO_DATABASE_PATH = 'memory://'
  DEMO_AUTH_ENABLED = 'true'
  SESSION_TTL_MINUTES = '480'
  WORKER_MODE = 'once'
  WORKER_QUEUE_ADAPTER = 'inline'
  WORKER_POLL_INTERVAL_MS = '60000'
  WORKER_HEALTH_PORT = '33101'
  LOG_LEVEL = 'silent'
  DEMO_RESET_CONFIRMATION = 'RESET_BEA_DEMO_DATA'
}

foreach ($entry in $verificationEnvironment.GetEnumerator()) {
  Set-Item -LiteralPath "Env:$($entry.Key)" -Value $entry.Value
}

& node 'scripts/repository-boundary.mjs'
if ($LASTEXITCODE -ne 0) {
  throw 'Repository boundary verification failed.'
}

$checks = @(
  @{ Name = 'Frozen dependency installation'; Command = @('install', '--frozen-lockfile') },
  @{ Name = 'Source integrity'; Command = @('source:verify') },
  @{ Name = 'Formatting'; Command = @('format:check') },
  @{ Name = 'Lint'; Command = @('lint') },
  @{ Name = 'Type checking'; Command = @('typecheck') },
  @{ Name = 'Unit tests'; Command = @('test:unit') },
  @{ Name = 'Component tests'; Command = @('test:component') },
  @{ Name = 'Integration tests'; Command = @('test:integration') },
  @{ Name = 'Demo database service boundary'; Command = @('db:start') },
  @{ Name = 'Database migration'; Command = @('db:migrate') },
  @{ Name = 'Deterministic seed'; Command = @('db:seed') },
  @{ Name = 'Repeatable seed'; Command = @('db:seed') },
  @{ Name = 'Guarded demo reset'; Command = @('demo:reset') },
  @{ Name = 'Post-reset seed'; Command = @('db:seed') },
  @{ Name = 'Foundation workflow'; Command = @('workflow:foundation') },
  @{ Name = 'Worker startup and health smoke'; Command = @('smoke:worker') },
  @{ Name = 'Web build'; Command = @('build:web') },
  @{ Name = 'Built web startup and health smoke'; Command = @('smoke:web') },
  @{ Name = 'Worker build'; Command = @('build:worker') },
  @{ Name = 'Full build'; Command = @('build') },
  @{ Name = 'Dependency audit'; Command = @('security:audit') },
  @{ Name = 'Secret scan'; Command = @('security:secrets') }
)

if (-not $SkipEndToEnd) {
  $checks += @{ Name = 'Web startup, health endpoint, and end-to-end tests'; Command = @('test:e2e') }
}

$results = @()
if ($SkipEndToEnd) {
  $results += [pscustomobject]@{
    Check = 'Web startup, health endpoint, and end-to-end tests'
    ExitCode = $null
    Result = 'NOT_RUN'
  }
}
$databaseBoundaryStarted = $false
try {
  foreach ($check in $checks) {
    Write-Host "==> $($check.Name)"
    & $pnpmCommand @($check.Command)
    $exitCode = $LASTEXITCODE
    $results += [pscustomobject]@{
      Check = $check.Name
      ExitCode = $exitCode
      Result = if ($exitCode -eq 0) { 'PASS' } else { 'FAIL' }
    }
    if ($check.Name -eq 'Demo database service boundary' -and $exitCode -eq 0) {
      $databaseBoundaryStarted = $true
    }
    if ($exitCode -ne 0) {
      $results | Format-Table -AutoSize
      throw "$($check.Name) failed with exit code $exitCode."
    }
  }
}
finally {
  if ($databaseBoundaryStarted) {
    Write-Host '==> Demo database shutdown boundary'
    & $pnpmCommand db:stop
    $stopExitCode = $LASTEXITCODE
    $results += [pscustomobject]@{
      Check = 'Demo database shutdown boundary'
      ExitCode = $stopExitCode
      Result = if ($stopExitCode -eq 0) { 'PASS' } else { 'FAIL' }
    }
    if ($stopExitCode -ne 0) {
      $results | Format-Table -AutoSize
      throw "Demo database shutdown boundary failed with exit code $stopExitCode."
    }
  }
}

Write-Host '==> Git status'
$safeRepository = $repoRoot.Replace('\', '/')
$gitStatus = @(& git -c "safe.directory=$safeRepository" status --porcelain=v1 2>&1)
$gitExitCode = $LASTEXITCODE
$unstagedOrUntracked = @(
  $gitStatus | Where-Object {
    $_ -is [string] -and (
      $_.Length -lt 2 -or
      $_.Substring(0, 2) -eq '??' -or
      $_[1] -ne ' '
    )
  }
)
$gitResult = if ($gitExitCode -ne 0 -or $unstagedOrUntracked.Count -gt 0) {
  'FAIL'
}
elseif ($gitStatus.Count -eq 0) {
  'PASS_CLEAN'
}
else {
  'PASS_STAGED'
}
$results += [pscustomobject]@{
  Check = 'Git status'
  ExitCode = $gitExitCode
  Result = $gitResult
}
if ($gitStatus.Count -gt 0) {
  $gitStatus | ForEach-Object { Write-Host $_ }
}
if ($gitResult -eq 'FAIL') {
  $results | Format-Table -AutoSize
  throw 'Git status must be clean or contain only intentionally staged changes.'
}

$results | Format-Table -AutoSize
if ($SkipEndToEnd) {
  Write-Host 'PHASE0_VERIFICATION=BLOCKED_E2E_NOT_RUN'
  exit 2
}
Write-Host 'PHASE0_VERIFICATION=PASS'
