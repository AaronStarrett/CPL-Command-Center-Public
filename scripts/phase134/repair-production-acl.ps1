[CmdletBinding()]
param(
  [switch]$Elevated,
  [string]$InitiatingSid,
  [string]$Target
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ApprovalPhrase = 'REPAIR BEA PERMISSIONS'
$SystemSidValue = 'S-1-5-18'
$SidPattern = '^S-1-(?:\d+-){1,14}\d+$'
$SecuritySections = [Security.AccessControl.AccessControlSections]::Access -bor
  [Security.AccessControl.AccessControlSections]::Owner

$StageIds = @{
  validation = 1
  capture = 2
  'inheritance-and-grant-replacement' = 3
  'owner-assignment' = 4
  'exact-verification' = 5
}
$CategoryIds = @{
  TARGET_OUTSIDE_ROOT = 1
  PROTECTED_REPOSITORY_REFUSED = 2
  REPARSE_POINT_REFUSED = 3
  SID_MISMATCH = 4
  UNKNOWN_SID = 5
  TARGET_MISSING = 6
  ACCESS_DENIED = 7
  DESCRIPTOR_CAPTURE_FAILED = 8
  MUTATION_FAILED = 9
  EXACT_VERIFICATION_FAILED = 10
  HELPER_INTERNAL_FAILURE = 11
}
$StageNames = @{
  1 = 'validation'
  2 = 'capture'
  3 = 'inheritance-and-grant-replacement'
  4 = 'owner-assignment'
  5 = 'exact-verification'
}
$CategoryNames = @{
  1 = 'TARGET_OUTSIDE_ROOT'
  2 = 'PROTECTED_REPOSITORY_REFUSED'
  3 = 'REPARSE_POINT_REFUSED'
  4 = 'SID_MISMATCH'
  5 = 'UNKNOWN_SID'
  6 = 'TARGET_MISSING'
  7 = 'ACCESS_DENIED'
  8 = 'DESCRIPTOR_CAPTURE_FAILED'
  9 = 'MUTATION_FAILED'
  10 = 'EXACT_VERIFICATION_FAILED'
  11 = 'HELPER_INTERNAL_FAILURE'
}

function Get-CanonicalProductRoot {
  $localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'ACL_TARGET_OUTSIDE_ROOT'
  }
  return [IO.Path]::GetFullPath(
    [IO.Path]::Combine($localAppData, 'BEA', 'CommandCenter')
  ).TrimEnd('\')
}

function Test-PathEqual([string]$Left, [string]$Right) {
  return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals(
    [IO.Path]::GetFullPath($Right).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Test-PathMissingException($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [IO.FileNotFoundException] -or
        $exception -is [IO.DirectoryNotFoundException]) {
      return $true
    }
    $exception = $exception.InnerException
  }
  return $false
}

function Assert-NoReparsePath([string]$Candidate) {
  $targetFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $volumeRoot = [IO.Path]::GetPathRoot($targetFull)
  if ([string]::IsNullOrWhiteSpace($volumeRoot)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  $current = $volumeRoot
  $relativePath = $targetFull.Substring($volumeRoot.Length).TrimStart('\')
  $segments = if ($relativePath.Length -gt 0) { @($relativePath.Split('\')) } else { @() }
  foreach ($segment in @('') + $segments) {
    if ($segment.Length -gt 0) { $current = [IO.Path]::Combine($current, $segment) }
    try {
      $attributes = [IO.File]::GetAttributes($current)
    }
    catch {
      if (Test-PathMissingException $_) { continue }
      throw
    }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'ACL_REPARSE_POINT_REFUSED'
    }
  }
}

function Get-ValidatedSystemPowerShell {
  $candidate = [IO.Path]::Combine($PSHOME, 'powershell.exe')
  $expected = [IO.Path]::Combine(
    [Environment]::SystemDirectory,
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  if (-not (Test-PathEqual $candidate $expected)) {
    throw 'ACL_POWERSHELL_EXECUTABLE_REFUSED'
  }
  Assert-NoReparsePath $candidate
  if (-not [IO.File]::Exists($candidate)) {
    throw 'ACL_POWERSHELL_EXECUTABLE_REFUSED'
  }
  return [IO.Path]::GetFullPath($candidate)
}

function Assert-CanonicalExistingTarget([string]$Candidate) {
  $canonical = Get-CanonicalProductRoot
  if ([string]::IsNullOrWhiteSpace($Candidate) -or -not (Test-PathEqual $Candidate $canonical)) {
    throw 'ACL_TARGET_OUTSIDE_ROOT'
  }
  Assert-NoReparsePath $canonical
  if (-not [IO.Directory]::Exists($canonical)) {
    throw 'ACL_TARGET_MISSING'
  }
  return $canonical
}

function Get-CurrentSid {
  return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Assert-InitiatingIdentity([string]$ExpectedSid, [bool]$RequireAdministrator) {
  if ([string]::IsNullOrWhiteSpace($ExpectedSid) -or $ExpectedSid -notmatch $SidPattern) {
    throw 'ACL_UNKNOWN_SID'
  }
  try {
    $sid = [Security.Principal.SecurityIdentifier]::new($ExpectedSid)
    $null = $sid.Translate([Security.Principal.NTAccount])
  }
  catch [Security.Principal.IdentityNotMappedException] {
    throw 'ACL_UNKNOWN_SID'
  }
  catch [ArgumentException] {
    throw 'ACL_UNKNOWN_SID'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -ne $sid.Value) {
    throw 'ACL_SID_MISMATCH'
  }
  if ($RequireAdministrator) {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'ACL_ACCESS_DENIED'
    }
  }
  return $sid
}

function Get-DirectorySecurity([string]$Path, $Sections) {
  return [IO.Directory]::GetAccessControl($Path, $Sections)
}

function Set-DirectorySecurity([string]$Path, $Descriptor) {
  [IO.Directory]::SetAccessControl($Path, $Descriptor)
}

function Test-ExactProductRootPolicy(
  [string]$Path,
  [Security.Principal.SecurityIdentifier]$OwnerSid
) {
  $descriptor = Get-DirectorySecurity $Path $SecuritySections
  if (-not $descriptor.AreAccessRulesProtected) { return $false }
  if ($descriptor.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $OwnerSid.Value) {
    return $false
  }

  $rules = @($descriptor.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))
  if ($rules.Count -ne 2) { return $false }

  $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($expectedSid in @($OwnerSid.Value, $SystemSidValue)) {
    $matching = @($rules | Where-Object {
      $_.IdentityReference.Value -eq $expectedSid -and
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
      $_.InheritanceFlags -eq $expectedInheritance -and
      $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
      -not $_.IsInherited
    })
    if ($matching.Count -ne 1) { return $false }
  }
  return $true
}

function Get-FailureCategory([string]$Stage, [System.Management.Automation.ErrorRecord]$Record) {
  $message = [string]$Record.Exception.Message
  $baseException = $Record.Exception
  $accessDenied = $false
  while ($null -ne $baseException) {
    if ($baseException -is [UnauthorizedAccessException] -or
        $baseException -is [Security.SecurityException]) {
      $accessDenied = $true
      break
    }
    $baseException = $baseException.InnerException
  }
  if ($message -eq 'ACL_TARGET_OUTSIDE_ROOT') { return 'TARGET_OUTSIDE_ROOT' }
  if ($message -eq 'ACL_PROTECTED_REPOSITORY_REFUSED') {
    return 'PROTECTED_REPOSITORY_REFUSED'
  }
  if ($message -eq 'ACL_REPARSE_POINT_REFUSED') { return 'REPARSE_POINT_REFUSED' }
  if ($message -eq 'ACL_SID_MISMATCH') { return 'SID_MISMATCH' }
  if ($message -eq 'ACL_UNKNOWN_SID') { return 'UNKNOWN_SID' }
  if ($message -eq 'ACL_TARGET_MISSING') { return 'TARGET_MISSING' }
  if ($message -eq 'ACL_ACCESS_DENIED' -or $accessDenied) {
    return 'ACCESS_DENIED'
  }
  if ($message -eq 'ACL_EXACT_VERIFICATION_FAILED') {
    return 'EXACT_VERIFICATION_FAILED'
  }
  if ($Stage -eq 'capture') { return 'DESCRIPTOR_CAPTURE_FAILED' }
  if ($Stage -eq 'inheritance-and-grant-replacement' -or $Stage -eq 'owner-assignment') {
    return 'MUTATION_FAILED'
  }
  if ($Stage -eq 'exact-verification') { return 'EXACT_VERIFICATION_FAILED' }
  return 'HELPER_INTERNAL_FAILURE'
}

function New-EncodedFailureExit(
  [string]$Stage,
  [string]$Category,
  [ValidateRange(0, 3)][int]$RollbackState
) {
  $stageId = $StageIds[$Stage]
  $categoryId = $CategoryIds[$Category]
  if ($null -eq $stageId) { $stageId = $StageIds.validation }
  if ($null -eq $categoryId) { $categoryId = $CategoryIds.HELPER_INTERNAL_FAILURE }
  return 0xA000 -bor ([int]$stageId -shl 8) -bor ([int]$categoryId -shl 2) -bor
    $RollbackState
}

function Convert-EncodedFailureExit([int]$ExitCode) {
  if (($ExitCode -band 0xF000) -ne 0xA000) { return $null }
  $stageId = ($ExitCode -shr 8) -band 0x0F
  $categoryId = ($ExitCode -shr 2) -band 0x3F
  $rollbackState = $ExitCode -band 0x03
  if (-not $StageNames.ContainsKey($stageId) -or -not $CategoryNames.ContainsKey($categoryId)) {
    return $null
  }
  return [pscustomobject][ordered]@{
    Stage = $StageNames[$stageId]
    Category = $CategoryNames[$categoryId]
    RollbackAttempted = $rollbackState -ne 0
    RollbackResult = if ($rollbackState -eq 1) { 'PASS' }
      elseif ($rollbackState -eq 2) { 'FAILED' }
      elseif ($rollbackState -eq 3) { 'UNKNOWN' }
      else { 'NOT_RUN' }
  }
}

function Invoke-ElevatedRepair {
  $stage = 'validation'
  $originalSddl = $null
  $mutationAttempted = $false
  $rollbackState = 0
  try {
    $canonical = Assert-CanonicalExistingTarget $Target
    $ownerSid = Assert-InitiatingIdentity $InitiatingSid $true

    $stage = 'capture'
    $originalDescriptor = Get-DirectorySecurity $canonical $SecuritySections
    $originalSddl = $originalDescriptor.GetSecurityDescriptorSddlForm($SecuritySections)

    $stage = 'inheritance-and-grant-replacement'
    $null = Assert-CanonicalExistingTarget $canonical
    $accessDescriptor = [Security.AccessControl.DirectorySecurity]::new()
    $accessDescriptor.SetAccessRuleProtection($true, $false)
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $systemSid = [Security.Principal.SecurityIdentifier]::new($SystemSidValue)
    $accessDescriptor.AddAccessRule(
      [Security.AccessControl.FileSystemAccessRule]::new(
        $ownerSid, $rights, $inheritance, $propagation, $allow
      )
    )
    $accessDescriptor.AddAccessRule(
      [Security.AccessControl.FileSystemAccessRule]::new(
        $systemSid, $rights, $inheritance, $propagation, $allow
      )
    )
    $mutationAttempted = $true
    Set-DirectorySecurity $canonical $accessDescriptor

    $stage = 'owner-assignment'
    $null = Assert-CanonicalExistingTarget $canonical
    $ownerDescriptor = Get-DirectorySecurity $canonical (
      [Security.AccessControl.AccessControlSections]::Owner
    )
    $ownerDescriptor.SetOwner($ownerSid)
    Set-DirectorySecurity $canonical $ownerDescriptor

    $stage = 'exact-verification'
    $null = Assert-CanonicalExistingTarget $canonical
    if (-not (Test-ExactProductRootPolicy $canonical $ownerSid)) {
      throw 'ACL_EXACT_VERIFICATION_FAILED'
    }
    exit 0
  }
  catch {
    $failureCategory = Get-FailureCategory $stage $_
    if ($mutationAttempted -and $null -ne $originalSddl) {
      $rollbackState = 2
      try {
        $canonical = Assert-CanonicalExistingTarget $Target
        $null = Assert-InitiatingIdentity $InitiatingSid $true
        $rollbackDescriptor = [Security.AccessControl.DirectorySecurity]::new()
        $rollbackDescriptor.SetSecurityDescriptorSddlForm($originalSddl, $SecuritySections)
        Set-DirectorySecurity $canonical $rollbackDescriptor
        $rollbackInspection = Get-DirectorySecurity $canonical $SecuritySections
        if ($rollbackInspection.GetSecurityDescriptorSddlForm($SecuritySections) -eq $originalSddl) {
          $rollbackState = 1
        }
      }
      catch {
        $rollbackState = 2
      }
    }
    exit (New-EncodedFailureExit $stage $failureCategory $rollbackState)
  }
}

function Invoke-NormalLauncher {
  # Do not read the target before UAC. This entry point remains usable even if a
  # failed rollback left the normal token unable to traverse CommandCenter.
  $canonical = Get-CanonicalProductRoot
  $currentSid = Get-CurrentSid
  $null = Assert-InitiatingIdentity $currentSid $false

  [Console]::Out.WriteLine('BEA Windows permissions recovery helper')
  [Console]::Out.WriteLine("AclTarget: $canonical")
  [Console]::Out.WriteLine("AclDesiredOwner: $currentSid")
  [Console]::Out.WriteLine("AclDesiredGrants: $currentSid=FullControl; $SystemSidValue=FullControl")
  [Console]::Out.WriteLine('AclScope: only the target descriptor is directly written; the parent and file bytes are untouched. Protected descendant ACLs remain unchanged, while unprotected descendants inherit the restricted grants without recursive enumeration.')
  [Console]::Out.WriteLine('AclElevation: this helper alone will request one-time UAC elevation and exit immediately.')
  [Console]::Out.WriteLine('AclRollback: the original owner and DACL remain only in elevated-process memory and are restored on verified failure where safely possible.')
  [Console]::Out.WriteLine("ApprovalPhrase: $ApprovalPhrase")
  $response = Read-Host "Type $ApprovalPhrase to continue"
  if ($response -cne $ApprovalPhrase) {
    [Console]::Error.WriteLine('BEA_ACL_REPAIR=DECLINED')
    exit 10
  }

  $powershell = Get-ValidatedSystemPowerShell
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $powershell
  $startInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    $PSCommandPath + '" -Elevated -InitiatingSid "' + $currentSid + '" -Target "' +
    $canonical + '"'
  $startInfo.UseShellExecute = $true
  $startInfo.Verb = 'runas'
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden

  try {
    $process = [Diagnostics.Process]::Start($startInfo)
    $process.WaitForExit()
  }
  catch [ComponentModel.Win32Exception] {
    if ($_.Exception.NativeErrorCode -eq 1223) {
      [Console]::Error.WriteLine('BEA_ACL_REPAIR=BLOCKED category=UAC_DECLINED')
      exit 1223
    }
    [Console]::Error.WriteLine('BEA_ACL_REPAIR=BLOCKED category=ELEVATION_LAUNCH_FAILED')
    exit 11
  }

  if ($process.ExitCode -eq 0) {
    [Console]::Out.WriteLine("BEA_ACL_REPAIR=PASS target=$canonical")
    exit 0
  }
  $evidence = Convert-EncodedFailureExit $process.ExitCode
  if ($null -eq $evidence) {
    [Console]::Error.WriteLine(
      "BEA_ACL_REPAIR=BLOCKED stage=elevated-helper category=HELPER_PROCESS_FAILED exit=$($process.ExitCode) rollback=UNKNOWN"
    )
    exit $process.ExitCode
  }
  [Console]::Error.WriteLine(
    "BEA_ACL_REPAIR=BLOCKED stage=$($evidence.Stage) category=$($evidence.Category) exit=$($process.ExitCode) rollback=$($evidence.RollbackResult)"
  )
  if ($evidence.RollbackResult -eq 'FAILED') {
    [Console]::Error.WriteLine(
      "AclRecoveryCommand: & `"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    )
  }
  exit $process.ExitCode
}

if ($Elevated) {
  Invoke-ElevatedRepair
  exit 1
}

try {
  Invoke-NormalLauncher
}
catch {
  $category = Get-FailureCategory 'validation' $_
  [Console]::Error.WriteLine("BEA_ACL_REPAIR=BLOCKED stage=validation category=$category")
  exit 1
}
