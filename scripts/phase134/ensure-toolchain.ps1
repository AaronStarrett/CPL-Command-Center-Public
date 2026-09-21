$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedNodeVersion = '24.19.0'
$ExpectedPnpmVersion = '11.19.0'
$PinnedArchiveHash = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
$ArchiveName = "node-v$ExpectedNodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$ExpectedNodeVersion/$ArchiveName"
$ChecksumUrl = "https://nodejs.org/dist/v$ExpectedNodeVersion/SHASUMS256.txt"
$TargetRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$ProtectedRepository = [IO.Path]::GetFullPath('C:\CPL-Dev\Cyber Pirate Labs Command Center')
$CurrentDirectory = [IO.Path]::GetFullPath((Get-Location).Path)

if (-not $CurrentDirectory.Equals($TargetRepository, [StringComparison]::OrdinalIgnoreCase)) {
  throw "BEA repository boundary refused: run this command from $TargetRepository."
}
if ($CurrentDirectory.Equals($ProtectedRepository, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'BEA repository boundary refused the protected CPL repository.'
}
[Console]::Out.WriteLine('{"code":"BEA_REPOSITORY_BOUNDARY_OK","protectedRepositoryEntered":false}')

$CheckOnly = $false
$ConfirmedDownload = $false
foreach ($Argument in $args) {
  if ($Argument -eq '--check') { $CheckOnly = $true }
  elseif ($Argument -eq '--confirm-download') { $ConfirmedDownload = $true }
  else { throw 'Usage: Ensure-BEA-Toolchain.cmd [--check] [--confirm-download]' }
}
if ($CheckOnly -and $ConfirmedDownload) {
  throw '--check cannot be combined with --confirm-download.'
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required for the BEA-owned toolchain.'
}
$LocalAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$ProductRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData 'BEA\CommandCenter'))
$ToolchainRoot = Join-Path $ProductRoot 'toolchain'
$NodeRoot = Join-Path $ToolchainRoot "node-v$ExpectedNodeVersion-win-x64"
$NodeExecutable = Join-Path $NodeRoot 'node.exe'
$CorepackJavaScript = Join-Path $NodeRoot 'node_modules\corepack\dist\corepack.js'
$CorepackHome = Join-Path $ToolchainRoot 'corepack-home'
$PnpmHome = Join-Path $ToolchainRoot 'pnpm-home'
$PnpmExecutable = Join-Path $ToolchainRoot 'bin\pnpm.cmd'
$DownloadRoot = Join-Path $ToolchainRoot 'downloads'
$StagingRoot = Join-Path $ToolchainRoot 'staging'
$MetadataFile = Join-Path $ToolchainRoot 'toolchain.json'
$ToolchainOperationLock = Join-Path $ToolchainRoot '.bea-toolchain-operation.lock'

function Assert-ContainedPath([string]$Parent, [string]$Candidate) {
  $ParentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $CandidatePath = [IO.Path]::GetFullPath($Candidate)
  if (-not $CandidatePath.StartsWith($ParentPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Toolchain path escaped its BEA-owned root: $CandidatePath"
  }
}
Assert-ContainedPath $LocalAppData $ProductRoot
Assert-ContainedPath $ProductRoot $ToolchainRoot

function Get-ExactVersion([object[]]$OutputLines, [bool]$AllowNodePrefix) {
  $Pattern = if ($AllowNodePrefix) { '^v?\d+\.\d+\.\d+$' } else { '^\d+\.\d+\.\d+$' }
  $Lines = @($OutputLines | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne '' })
  if ($Lines.Count -ne 1 -or $Lines[0] -notmatch $Pattern) { return $null }
  return $Lines[0].TrimStart('v')
}

function Get-ToolchainStatus {
  $NodePresent = Test-Path -LiteralPath $NodeExecutable -PathType Leaf
  $PnpmPresent = Test-Path -LiteralPath $PnpmExecutable -PathType Leaf
  $NodeVersion = $null
  $PnpmVersion = $null
  $NodeExitCode = $null
  $PnpmExitCode = $null

  if ($NodePresent) {
    # Capture the native command completely before consulting LASTEXITCODE. In
    # Windows PowerShell 5.1 a native .cmd piped into Select-Object -First 1 can
    # emit the correct value but leave LASTEXITCODE at -1.
    $NodeOutput = @(& $NodeExecutable --version 2>$null)
    $NodeExitCode = $LASTEXITCODE
    $NodeVersion = Get-ExactVersion $NodeOutput $true
  }
  $NodeReady = $NodePresent -and $NodeExitCode -eq 0 -and $NodeVersion -eq $ExpectedNodeVersion

  if ($PnpmPresent -and $NodeReady) {
    $PriorCorepackHome = $env:COREPACK_HOME
    $PriorPnpmHome = $env:PNPM_HOME
    $PriorPath = $env:Path
    try {
      $env:COREPACK_HOME = $CorepackHome
      $env:PNPM_HOME = $PnpmHome
      $env:Path = "$NodeRoot;$(Split-Path -Parent $PnpmExecutable);$PriorPath"
      $PnpmOutput = @(& $PnpmExecutable --version 2>$null)
      $PnpmExitCode = $LASTEXITCODE
      $PnpmVersion = Get-ExactVersion $PnpmOutput $false
    }
    finally {
      $env:COREPACK_HOME = $PriorCorepackHome
      $env:PNPM_HOME = $PriorPnpmHome
      $env:Path = $PriorPath
    }
  }
  $PnpmReady = $PnpmPresent -and $NodeReady -and $PnpmExitCode -eq 0 -and $PnpmVersion -eq $ExpectedPnpmVersion
  $ToolchainReady = $NodeReady -and $PnpmReady
  $Code = if ($ToolchainReady) { 'TOOLCHAIN_READY' }
    elseif (-not $NodePresent) { 'NODE_MISSING' }
    elseif ($NodeExitCode -ne 0) { 'NODE_FAILED' }
    elseif ($NodeVersion -ne $ExpectedNodeVersion) { 'NODE_VERSION_MISMATCH' }
    elseif (-not $PnpmPresent) { 'PNPM_MISSING' }
    elseif ($PnpmExitCode -ne 0) { 'PNPM_FAILED' }
    else { 'PNPM_VERSION_MISMATCH' }

  return [pscustomobject][ordered]@{
    Ready = $ToolchainReady
    Code = $Code
    NodePath = $NodeExecutable
    NodeVersion = $NodeVersion
    NodeReady = $NodeReady
    NodeExitCode = $NodeExitCode
    PnpmPath = $PnpmExecutable
    PnpmVersion = $PnpmVersion
    PnpmReady = $PnpmReady
    PnpmExitCode = $PnpmExitCode
    ToolchainReady = $ToolchainReady
  }
}

function Write-ToolchainStatus([object]$Status) {
  $Diagnostic = [ordered]@{
    NodePath = $Status.NodePath
    NodeVersion = $Status.NodeVersion
    NodeReady = $Status.NodeReady
    NodeExitCode = $Status.NodeExitCode
    PnpmPath = $Status.PnpmPath
    PnpmVersion = $Status.PnpmVersion
    PnpmReady = $Status.PnpmReady
    PnpmExitCode = $Status.PnpmExitCode
    ToolchainReady = $Status.ToolchainReady
    Code = $Status.Code
  }
  $Json = $Diagnostic | ConvertTo-Json -Compress
  [Console]::Out.WriteLine("BEA_TOOLCHAIN_STATUS=$Json")
}

function Get-PnpmShimText {
  return (@(
    '@echo off',
    'setlocal',
    "set `"PATH=$NodeRoot;$(Split-Path -Parent $PnpmExecutable);%PATH%`"",
    "set `"COREPACK_HOME=$CorepackHome`"",
    "set `"PNPM_HOME=$PnpmHome`"",
    "`"$NodeExecutable`" `"$CorepackJavaScript`" pnpm %*",
    'exit /b %errorlevel%',
    ''
  ) -join "`r`n")
}

function Install-PnpmShimIfRequired {
  $ExpectedShim = Get-PnpmShimText
  $ExistingShim = if (Test-Path -LiteralPath $PnpmExecutable -PathType Leaf) {
    [IO.File]::ReadAllText($PnpmExecutable)
  } else { $null }
  if ($ExistingShim -ceq $ExpectedShim) {
    return [pscustomobject]@{ Changed = $false; Existed = $true; PreviousContent = $ExistingShim }
  }
  [IO.Directory]::CreateDirectory((Split-Path -Parent $PnpmExecutable)) | Out-Null
  $TemporaryShim = "$PnpmExecutable.$PID.tmp"
  Assert-ContainedPath $ToolchainRoot $TemporaryShim
  [IO.File]::WriteAllText($TemporaryShim, $ExpectedShim, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $TemporaryShim -Destination $PnpmExecutable -Force
  return [pscustomobject]@{
    Changed = $true
    Existed = $null -ne $ExistingShim
    PreviousContent = $ExistingShim
  }
}

function Restore-PnpmShim([object]$Change) {
  if (-not $Change.Changed) { return }
  if ($Change.Existed) {
    [IO.File]::WriteAllText($PnpmExecutable, [string]$Change.PreviousContent, [Text.UTF8Encoding]::new($false))
  } elseif (Test-Path -LiteralPath $PnpmExecutable -PathType Leaf) {
    Remove-Item -LiteralPath $PnpmExecutable -Force
  }
}

function Test-ExactToolchainAcl(
  [object]$Acl,
  [Security.Principal.SecurityIdentifier]$CurrentSid,
  [Security.Principal.SecurityIdentifier]$SystemSid
) {
  $OwnerSidValue = [string]$Acl.Owner
  try {
    $OwnerSidValue = ([Security.Principal.NTAccount]$Acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch { }
  $ExpectedSids = @($CurrentSid.Value, $SystemSid.Value)
  $ExpectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $ExpectedPropagation = [Security.AccessControl.PropagationFlags]::None
  $ExpectedAccessType = [Security.AccessControl.AccessControlType]::Allow
  $ExpectedRights = [Security.AccessControl.FileSystemRights]::FullControl
  $Rules = @($Acl.Access)
  $RuleSids = @($Rules | ForEach-Object {
    try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { '' }
  })
  $ValidRules = @($Rules | Where-Object {
    $RuleSid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' }
    $RuleSid -in $ExpectedSids -and
      $_.AccessControlType -eq $ExpectedAccessType -and
      $_.FileSystemRights -eq $ExpectedRights -and
      $_.InheritanceFlags -eq $ExpectedInheritance -and
      $_.PropagationFlags -eq $ExpectedPropagation -and
      -not $_.IsInherited
  })
  return $Acl.AreAccessRulesProtected -and
    $OwnerSidValue -eq $CurrentSid.Value -and
    $Rules.Count -eq 2 -and
    $ValidRules.Count -eq 2 -and
    @($RuleSids | Where-Object { $_ -eq $CurrentSid.Value }).Count -eq 1 -and
    @($RuleSids | Where-Object { $_ -eq $SystemSid.Value }).Count -eq 1
}

function Complete-ToolchainRegistration([string]$ArchiveSha256) {
  $MetadataReady = $false
  if (Test-Path -LiteralPath $MetadataFile -PathType Leaf) {
    try {
      $ExistingMetadata = Get-Content -LiteralPath $MetadataFile -Raw | ConvertFrom-Json
      $MetadataReady = $ExistingMetadata.schemaVersion -eq 1 -and
        $ExistingMetadata.nodeVersion -eq $ExpectedNodeVersion -and
        $ExistingMetadata.pnpmVersion -eq $ExpectedPnpmVersion -and
        $ExistingMetadata.archiveSha256 -eq $ArchiveSha256
    } catch { $MetadataReady = $false }
  }
  if (-not $MetadataReady) {
    $Metadata = [ordered]@{
      schemaVersion = 1
      nodeVersion = $ExpectedNodeVersion
      pnpmVersion = $ExpectedPnpmVersion
      nodeSource = $NodeUrl
      checksumSource = $ChecksumUrl
      archiveSha256 = $ArchiveSha256
      installedAt = [DateTime]::UtcNow.ToString('o')
    }
    $MetadataTemporary = "$MetadataFile.$PID.tmp"
    [IO.File]::WriteAllText($MetadataTemporary, (($Metadata | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $MetadataTemporary -Destination $MetadataFile -Force
  }

  $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $SystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $CurrentAcl = Get-Acl -LiteralPath $ToolchainRoot
  if (-not (Test-ExactToolchainAcl $CurrentAcl $CurrentSid $SystemSid)) {
    $ToolchainAcl = [Security.AccessControl.DirectorySecurity]::new()
    $ToolchainAcl.SetAccessRuleProtection($true, $false)
    $ToolchainAcl.SetOwner($CurrentSid)
    $FullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $Propagation = [Security.AccessControl.PropagationFlags]::None
    $Allow = [Security.AccessControl.AccessControlType]::Allow
    $ToolchainAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($CurrentSid, $FullControl, $Inheritance, $Propagation, $Allow))
    $ToolchainAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($SystemSid, $FullControl, $Inheritance, $Propagation, $Allow))
    [IO.Directory]::SetAccessControl($ToolchainRoot, $ToolchainAcl)
  }
  $VerifiedAcl = Get-Acl -LiteralPath $ToolchainRoot
  if (-not (Test-ExactToolchainAcl $VerifiedAcl $CurrentSid $SystemSid)) {
    throw 'Toolchain ACL verification failed.'
  }
}

$ToolchainOperationLockStream = $null
try {
  if (-not $CheckOnly) {
    [IO.Directory]::CreateDirectory($ToolchainRoot) | Out-Null
    try {
      $ToolchainOperationLockStream = [IO.FileStream]::new(
        $ToolchainOperationLock,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None,
        4096,
        [IO.FileOptions]::DeleteOnClose
      )
    }
    catch [IO.IOException] {
      throw 'BEA toolchain provisioning is blocked because another cleanup or toolchain operation is active.'
    }
    $OperationMetadata = [Text.Encoding]::UTF8.GetBytes("pid=$PID`nstartedAt=$([DateTime]::UtcNow.ToString('o'))`n")
    $ToolchainOperationLockStream.Write($OperationMetadata, 0, $OperationMetadata.Length)
    $ToolchainOperationLockStream.Flush($true)
  }

  $ExistingStatus = Get-ToolchainStatus
  Write-ToolchainStatus $ExistingStatus
  if ($ExistingStatus.Ready) {
  if (-not $CheckOnly) {
    $ShimChange = Install-PnpmShimIfRequired
    $NormalizedStatus = Get-ToolchainStatus
    Write-ToolchainStatus $NormalizedStatus
    if (-not $NormalizedStatus.Ready) {
      Restore-PnpmShim $ShimChange
      throw 'The normalized BEA pnpm wrapper failed exact version verification; the previous wrapper was restored.'
    }
    $ExistingStatus = $NormalizedStatus
    Complete-ToolchainRegistration $PinnedArchiveHash
  }
  [Console]::Out.WriteLine("BEA_TOOLCHAIN=PASS node=$($ExistingStatus.NodeVersion) pnpm=$($ExistingStatus.PnpmVersion)")
    exit 0
  }
  if ($CheckOnly) {
    [Console]::Out.WriteLine("BEA_TOOLCHAIN=SETUP_REQUIRED code=$($ExistingStatus.Code)")
    exit 1
  }

$ReusableNode = $false
if (Test-Path -LiteralPath $NodeRoot) {
  if (-not $ExistingStatus.NodeReady -or
      -not (Test-Path -LiteralPath $CorepackJavaScript -PathType Leaf)) {
    throw "An invalid existing BEA Node directory was preserved at $NodeRoot. Remove it explicitly before retrying."
  }
  $ReusableNode = $true
}

if (-not $ConfirmedDownload) {
  if ($ReusableNode) {
    [Console]::Out.WriteLine('BEA will reuse the exact installed Node 24.19.0 runtime and repair only the isolated pnpm 11.19.0 command.')
  } else {
    [Console]::Out.WriteLine('BEA will download Node 24.19.0 from nodejs.org, verify SHASUMS256.txt, and install an isolated pnpm 11.19.0 runtime.')
  }
  [Console]::Out.WriteLine("Publisher: OpenJS Foundation / Node.js; destination: $ToolchainRoot; estimated disk: approximately 250 MB plus cache.")
  [Console]::Out.WriteLine("Rollback: stop BEA, then remove only $ToolchainRoot.")
  $Response = Read-Host 'Type INSTALL BEA TOOLCHAIN to approve'
  if ($Response -cne 'INSTALL BEA TOOLCHAIN') {
    throw 'Owner declined the BEA toolchain installation.'
  }
}

[IO.Directory]::CreateDirectory($CorepackHome) | Out-Null
[IO.Directory]::CreateDirectory($PnpmHome) | Out-Null
$ActualHash = $PinnedArchiveHash
if (-not $ReusableNode) {
  [IO.Directory]::CreateDirectory($DownloadRoot) | Out-Null
  [IO.Directory]::CreateDirectory($StagingRoot) | Out-Null
  $ArchivePath = Join-Path $DownloadRoot $ArchiveName
  $ChecksumPath = Join-Path $DownloadRoot 'SHASUMS256.txt'
  Invoke-WebRequest -Uri $ChecksumUrl -OutFile $ChecksumPath -MaximumRedirection 0
  Invoke-WebRequest -Uri $NodeUrl -OutFile $ArchivePath -MaximumRedirection 0

  $ChecksumLines = Get-Content -LiteralPath $ChecksumPath
  $ArchiveMatches = @($ChecksumLines | Where-Object { $_ -match "^([a-f0-9]{64})\s+\*?$([regex]::Escape($ArchiveName))$" })
  if ($ArchiveMatches.Count -ne 1) { throw 'Exact Node archive checksum was not found uniquely.' }
  $ExpectedHash = ([regex]::Match($ArchiveMatches[0], '^([a-f0-9]{64})')).Groups[1].Value
  if ($ExpectedHash -cne $PinnedArchiveHash) { throw 'Official checksum manifest did not match the pinned Node archive hash.' }
  $ActualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) { throw 'Node archive checksum mismatch; extraction was refused.' }

  $Stage = Join-Path $StagingRoot ([Guid]::NewGuid().ToString('N'))
  Assert-ContainedPath $StagingRoot $Stage
  [IO.Directory]::CreateDirectory($Stage) | Out-Null
  try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Stage
    $ExtractedRoot = Join-Path $Stage "node-v$ExpectedNodeVersion-win-x64"
    if (-not (Test-Path -LiteralPath (Join-Path $ExtractedRoot 'node.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $ExtractedRoot 'node_modules\corepack\dist\corepack.js') -PathType Leaf)) {
      throw 'Verified Node archive did not contain the expected toolchain layout.'
    }
    Move-Item -LiteralPath $ExtractedRoot -Destination $NodeRoot
  }
  finally {
    $ResolvedStage = [IO.Path]::GetFullPath($Stage)
    Assert-ContainedPath $StagingRoot $ResolvedStage
    if (Test-Path -LiteralPath $ResolvedStage) { Remove-Item -LiteralPath $ResolvedStage -Recurse -Force }
  }
}

$PriorCorepackHome = $env:COREPACK_HOME
$PriorPnpmHome = $env:PNPM_HOME
$PriorPath = $env:Path
try {
  $env:COREPACK_HOME = $CorepackHome
  $env:PNPM_HOME = $PnpmHome
  $env:Path = "$NodeRoot;$(Split-Path -Parent $PnpmExecutable);$PriorPath"
  & $NodeExecutable $CorepackJavaScript prepare "pnpm@$ExpectedPnpmVersion" --activate
  if ($LASTEXITCODE -ne 0) { throw 'Isolated pnpm activation failed closed.' }
}
finally {
  $env:COREPACK_HOME = $PriorCorepackHome
  $env:PNPM_HOME = $PriorPnpmHome
  $env:Path = $PriorPath
}

$ShimChange = Install-PnpmShimIfRequired
$FinalStatus = Get-ToolchainStatus
Write-ToolchainStatus $FinalStatus
if (-not $FinalStatus.Ready) {
  Restore-PnpmShim $ShimChange
  throw 'The installed BEA toolchain failed exact version verification; the previous wrapper was restored.'
}
Complete-ToolchainRegistration $ActualHash
[Console]::Out.WriteLine("BEA_TOOLCHAIN=PASS node=$($FinalStatus.NodeVersion) pnpm=$($FinalStatus.PnpmVersion)")
}
finally {
  if ($null -ne $ToolchainOperationLockStream) {
    $ToolchainOperationLockStream.Dispose()
  }
}
