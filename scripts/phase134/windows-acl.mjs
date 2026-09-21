import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

import { FORBIDDEN_REPOSITORY, isPathWithin } from "../repository-boundary.mjs";
import { assertPathContained, productionPaths } from "./production-paths.mjs";

const sidPattern = /^S-1-(?:\d+-){1,14}\d+$/u;

export const ACL_SYSTEM_SID = "S-1-5-18";
export const ACL_ADMINISTRATORS_SID = "S-1-5-32-544";
export const ACL_REPAIR_APPROVAL = "REPAIR BEA PERMISSIONS";

const SYSTEM_WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ACL_STANDALONE_RECOVERY_COMMAND =
  '& "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\phase134\\repair-production-acl.ps1"';
const ACL_CONFIGURE_RECOVERY_COMMAND = ".\\Configure-BEA.cmd";

const replaceAclScript = String.raw`
$ErrorActionPreference = 'Stop'
function Test-ContainedPath([string]$Root, [string]$Candidate) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
    $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
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
function Assert-NoReparsePoint([string]$Root, [string]$Target) {
  if (-not (Test-ContainedPath $Root $Target)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  $targetFull = [IO.Path]::GetFullPath($Target).TrimEnd('\')
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
function Get-SecurityDescriptor([string]$Target, [bool]$Directory, $Sections) {
  if ($Directory) { return [IO.Directory]::GetAccessControl($Target, $Sections) }
  return [IO.File]::GetAccessControl($Target, $Sections)
}
function Test-AccessDeniedException($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [UnauthorizedAccessException] -or $exception -is [Security.SecurityException]) {
      return $true
    }
    $exception = $exception.InnerException
  }
  return $false
}
function Set-SecurityDescriptor([string]$Target, [bool]$Directory, $Acl) {
  if ($Directory) { [IO.Directory]::SetAccessControl($Target, $Acl); return }
  [IO.File]::SetAccessControl($Target, $Acl)
}
function Convert-Rules($Acl) {
  return @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [ordered]@{
    sid = [string]$_.IdentityReference.Value
    accessType = [int]$_.AccessControlType
    rights = [int64]$_.FileSystemRights
    inheritance = [int]$_.InheritanceFlags
    propagation = [int]$_.PropagationFlags
    inherited = [bool]$_.IsInherited
  }
})
}
function Get-Inspection([string]$Target, [bool]$Directory) {
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $actual = Get-SecurityDescriptor $Target $Directory $sections
  return [ordered]@{
    protected = [bool]$actual.AreAccessRulesProtected
    protectedAncestor = $null
    ownerSid = [string]$actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
    directory = $Directory
    reparsePoint = $false
    rules = @(Convert-Rules $actual)
  }
}
function Test-ExactPolicy($Inspection, [string]$OwnerSid, [bool]$Directory) {
  $expectedInheritance = if ($Directory) { 3 } else { 0 }
  $rules = @($Inspection.rules)
  if (-not $Inspection.protected -or $Inspection.ownerSid -ne $OwnerSid -or $rules.Count -ne 2) { return $false }
  foreach ($sid in @($OwnerSid, 'S-1-5-18')) {
    $matching = @($rules | Where-Object {
      $_.sid -eq $sid -and $_.accessType -eq 0 -and $_.rights -eq 2032127 -and
      $_.inheritance -eq $expectedInheritance -and $_.propagation -eq 0 -and -not $_.inherited
    })
    if ($matching.Count -ne 1) { return $false }
  }
  return $true
}

$stage = 'validation'
$originalSddl = $null
$ownerBefore = $null
$inheritanceBefore = $null
$mutationStarted = $false
$createdTarget = $false
$rollbackAttempted = $false
$rollbackSucceeded = $null
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath([string]$inputData.target)
  $allowedRoot = [IO.Path]::GetFullPath([string]$inputData.allowedRoot)
  $validationRoot = [IO.Path]::GetFullPath([string]$inputData.validationRoot)
  $forbiddenRoot = [IO.Path]::GetFullPath([string]$inputData.forbiddenRoot)
  if (-not (Test-ContainedPath $allowedRoot $target)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  if (Test-ContainedPath $forbiddenRoot $target) { throw 'ACL_PROTECTED_REPOSITORY_REFUSED' }
  if ([bool]$inputData.requireCanonicalProductRoot) {
    $canonicalRoot = [IO.Path]::GetFullPath([IO.Path]::Combine(
      [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData), 'BEA', 'CommandCenter'
    ))
    if (-not $target.Equals($canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  }
  Assert-NoReparsePoint $validationRoot $target
  $directory = [bool]$inputData.directory
  $targetExists = if ($directory) { [IO.Directory]::Exists($target) } else { [IO.File]::Exists($target) }
  $createIfMissing = [bool]$inputData.createIfMissing
  if (-not $targetExists -and (-not $directory -or -not $createIfMissing)) { throw 'ACL_TARGET_MISSING' }
  try {
    $ownerSid = [Security.Principal.SecurityIdentifier]::new([string]$inputData.currentUserSid)
    $null = $ownerSid.Translate([Security.Principal.NTAccount])
  }
  catch [Security.Principal.IdentityNotMappedException] { throw 'ACL_UNKNOWN_SID' }
  catch [ArgumentException] { throw 'ACL_UNKNOWN_SID' }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $ownerSid.Value) { throw 'ACL_SID_MISMATCH' }
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner

  $rights = [Security.AccessControl.FileSystemRights]::FullControl
  $allow = [Security.AccessControl.AccessControlType]::Allow
  if (-not $targetExists) {
    $stage = 'secure-directory-creation'
    Assert-NoReparsePoint $validationRoot $target
    $createAcl = [Security.AccessControl.DirectorySecurity]::new()
    $createAcl.SetAccessRuleProtection($true, $false)
    $createAcl.SetOwner($ownerSid)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $createAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerSid, $rights, $inheritance, $propagation, $allow))
    $createAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
    $mutationStarted = $true
    $null = [IO.Directory]::CreateDirectory($target, $createAcl)
    $createdTarget = $true
  }
  else {
    $stage = 'capture'
    $originalAcl = Get-SecurityDescriptor $target $directory $sections
    $originalSddl = $originalAcl.GetSecurityDescriptorSddlForm($sections)
    $ownerBefore = [string]$originalAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $inheritanceBefore = if ($originalAcl.AreAccessRulesProtected) { 'PROTECTED' } else { 'ENABLED' }

    $stage = 'inheritance-and-grant-replacement'
    Assert-NoReparsePoint $validationRoot $target
    $accessAcl = Get-SecurityDescriptor $target $directory ([Security.AccessControl.AccessControlSections]::Access)
    $accessAcl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($accessAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
      $null = $accessAcl.RemoveAccessRuleSpecific($rule)
    }
    if ($directory) {
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
      $propagation = [Security.AccessControl.PropagationFlags]::None
      $accessAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerSid, $rights, $inheritance, $propagation, $allow))
      $accessAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
    }
    else {
      $accessAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerSid, $rights, $allow))
      $accessAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $allow))
    }
    $mutationStarted = $true
    Set-SecurityDescriptor $target $directory $accessAcl

    $stage = 'owner-assignment'
    Assert-NoReparsePoint $validationRoot $target
    $ownerAcl = Get-SecurityDescriptor $target $directory ([Security.AccessControl.AccessControlSections]::Owner)
    $ownerAcl.SetOwner($ownerSid)
    Set-SecurityDescriptor $target $directory $ownerAcl
  }

  $stage = if ($createdTarget) { 'secure-directory-verification' } else { 'exact-verification' }
  Assert-NoReparsePoint $validationRoot $target
  $inspection = Get-Inspection $target $directory
  if ([bool]$inputData.testOnlyForceVerificationFailure) { throw 'ACL_EXACT_VERIFICATION_FAILED' }
  if (-not (Test-ExactPolicy $inspection $ownerSid.Value $directory)) { throw 'ACL_EXACT_VERIFICATION_FAILED' }
  [ordered]@{
    ok = $true
    applied = $true
    stage = 'complete'
    ownerBefore = $ownerBefore
    inheritanceBefore = $inheritanceBefore
    rollbackAttempted = $false
    rollbackSucceeded = $null
    inspection = $inspection
  } | ConvertTo-Json -Depth 7 -Compress | Write-Output
}
catch {
  $message = [string]$_.Exception.Message
  $failureCategory = if ($message -eq 'ACL_TARGET_OUTSIDE_ROOT') { 'TARGET_OUTSIDE_ROOT' }
    elseif ($message -eq 'ACL_PROTECTED_REPOSITORY_REFUSED') { 'PROTECTED_REPOSITORY_REFUSED' }
    elseif ($message -eq 'ACL_REPARSE_POINT_REFUSED') { 'REPARSE_POINT_REFUSED' }
    elseif ($message -eq 'ACL_SID_MISMATCH') { 'SID_MISMATCH' }
    elseif ($message -eq 'ACL_UNKNOWN_SID') { 'UNKNOWN_SID' }
    elseif ($message -eq 'ACL_TARGET_MISSING') { 'TARGET_MISSING' }
    elseif ($message -eq 'ACL_EXACT_VERIFICATION_FAILED') { 'EXACT_VERIFICATION_FAILED' }
    elseif (Test-AccessDeniedException $_) { 'ACCESS_DENIED' }
    elseif ($stage -eq 'capture') { 'DESCRIPTOR_CAPTURE_FAILED' }
    elseif ($stage -eq 'secure-directory-creation') { 'DIRECTORY_CREATION_FAILED' }
    else { 'MUTATION_FAILED' }
  if ($mutationStarted -and $null -ne $originalSddl) {
    $rollbackAttempted = $true
    try {
      Assert-NoReparsePoint $validationRoot $target
      $rollbackAcl = if ([bool]$inputData.directory) { [Security.AccessControl.DirectorySecurity]::new() }
        else { [Security.AccessControl.FileSecurity]::new() }
      $rollbackAcl.SetSecurityDescriptorSddlForm($originalSddl, $sections)
      Set-SecurityDescriptor $target ([bool]$inputData.directory) $rollbackAcl
      $rolledBack = Get-SecurityDescriptor $target ([bool]$inputData.directory) $sections
      $rollbackSucceeded = $rolledBack.GetSecurityDescriptorSddlForm($sections) -eq $originalSddl
    }
    catch { $rollbackSucceeded = $false }
  }
  $stageId = @{
    'validation' = 1
    'capture' = 2
    'inheritance-and-grant-replacement' = 3
    'owner-assignment' = 4
    'exact-verification' = 5
    'secure-directory-creation' = 6
    'secure-directory-verification' = 7
  }[$stage]
  if ($null -eq $stageId) { $stageId = 8 }
  $categoryId = @{
    'TARGET_OUTSIDE_ROOT' = 1
    'PROTECTED_REPOSITORY_REFUSED' = 2
    'REPARSE_POINT_REFUSED' = 3
    'SID_MISMATCH' = 4
    'UNKNOWN_SID' = 5
    'TARGET_MISSING' = 6
    'ACCESS_DENIED' = 7
    'DESCRIPTOR_CAPTURE_FAILED' = 8
    'MUTATION_FAILED' = 9
    'EXACT_VERIFICATION_FAILED' = 10
    'HELPER_INTERNAL_FAILURE' = 11
    'DIRECTORY_CREATION_FAILED' = 12
  }[$failureCategory]
  if ($null -eq $categoryId) { $categoryId = 11 }
  $rollbackId = if (-not $rollbackAttempted) { 0 }
    elseif ($rollbackSucceeded -eq $true) { 1 }
    elseif ($rollbackSucceeded -eq $false) { 2 }
    else { 3 }
  $exitCode = 0xA000 -bor ([int]$stageId -shl 8) -bor ([int]$categoryId -shl 2) -bor [int]$rollbackId
  [ordered]@{
    ok = $false
    applied = $false
    stage = $stage
    ownerBefore = $ownerBefore
    inheritanceBefore = $inheritanceBefore
    failureCategory = $failureCategory
    rollbackAttempted = $rollbackAttempted
    rollbackSucceeded = $rollbackSucceeded
  } | ConvertTo-Json -Depth 5 -Compress | Write-Output
  exit $exitCode
}
`;

const inspectAclScript = String.raw`
$ErrorActionPreference = 'Stop'
function Test-ContainedPath([string]$Root, [string]$Candidate) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
    $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
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
function Assert-NoReparsePoint([string]$Root, [string]$Target) {
  if (-not (Test-ContainedPath $Root $Target)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  $targetFull = [IO.Path]::GetFullPath($Target).TrimEnd('\')
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
function Get-SecurityDescriptor([string]$Target, [bool]$Directory, $Sections) {
  if ($Directory) { return [IO.Directory]::GetAccessControl($Target, $Sections) }
  return [IO.File]::GetAccessControl($Target, $Sections)
}
function Test-AccessDeniedException($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [UnauthorizedAccessException] -or $exception -is [Security.SecurityException]) {
      return $true
    }
    $exception = $exception.InnerException
  }
  return $false
}
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath([string]$inputData.target)
  $allowedRoot = [IO.Path]::GetFullPath([string]$inputData.allowedRoot)
  $validationRoot = [IO.Path]::GetFullPath([string]$inputData.validationRoot)
  $forbiddenRoot = [IO.Path]::GetFullPath([string]$inputData.forbiddenRoot)
  if (-not (Test-ContainedPath $allowedRoot $target)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  if (Test-ContainedPath $forbiddenRoot $target) { throw 'ACL_PROTECTED_REPOSITORY_REFUSED' }
  Assert-NoReparsePoint $validationRoot $target
  $directory = [bool]$inputData.directory
  if ($directory -and -not [IO.Directory]::Exists($target)) { throw 'ACL_TARGET_MISSING' }
  if (-not $directory -and -not [IO.File]::Exists($target)) { throw 'ACL_TARGET_MISSING' }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $actual = Get-SecurityDescriptor $target $directory $sections
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [ordered]@{
      sid = [string]$_.IdentityReference.Value
      accessType = [int]$_.AccessControlType
      rights = [int64]$_.FileSystemRights
      inheritance = [int]$_.InheritanceFlags
      propagation = [int]$_.PropagationFlags
      inherited = [bool]$_.IsInherited
    }
  })
  $protectedAncestor = $null
  if (-not $actual.AreAccessRulesProtected) {
    $parent = [IO.Directory]::GetParent($target)
    while ($null -ne $parent -and (Test-ContainedPath $allowedRoot $parent.FullName)) {
      $parentAcl = [IO.Directory]::GetAccessControl($parent.FullName, [Security.AccessControl.AccessControlSections]::Access)
      if ($parentAcl.AreAccessRulesProtected) { $protectedAncestor = $parent.FullName; break }
      if ($parent.FullName.TrimEnd('\').Equals($allowedRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { break }
      $parent = $parent.Parent
    }
  }
  [ordered]@{
    ok = $true
    protected = [bool]$actual.AreAccessRulesProtected
    protectedAncestor = $protectedAncestor
    ownerSid = [string]$actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
    directory = $directory
    reparsePoint = $false
    rules = $rules
  } | ConvertTo-Json -Depth 6 -Compress | Write-Output
}
catch {
  $message = [string]$_.Exception.Message
  $failureCategory = if ($message -eq 'ACL_TARGET_OUTSIDE_ROOT') { 'TARGET_OUTSIDE_ROOT' }
    elseif ($message -eq 'ACL_PROTECTED_REPOSITORY_REFUSED') { 'PROTECTED_REPOSITORY_REFUSED' }
    elseif ($message -eq 'ACL_REPARSE_POINT_REFUSED') { 'REPARSE_POINT_REFUSED' }
    elseif ($message -eq 'ACL_TARGET_MISSING') { 'TARGET_MISSING' }
    elseif (Test-AccessDeniedException $_) { 'ACCESS_DENIED' }
    else { 'INSPECTION_FAILED' }
  [ordered]@{ ok = $false; stage = 'inspection'; failureCategory = $failureCategory } |
    ConvertTo-Json -Compress | Write-Output
  exit 41
}
`;

const nativeReparsePreflightScript = String.raw`
$ErrorActionPreference = 'Stop'
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
function Test-AccessDeniedException($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [UnauthorizedAccessException] -or
        $exception -is [Security.SecurityException]) {
      return $true
    }
    $exception = $exception.InnerException
  }
  return $false
}
try {
  $systemPowerShell = [IO.Path]::Combine(
    [Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
  $currentPowerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  if (-not (Test-PathEqual $currentPowerShell $systemPowerShell)) {
    throw 'ACL_POWERSHELL_EXECUTABLE_REFUSED'
  }
  $target = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($target)) { throw 'ACL_TARGET_OUTSIDE_ROOT' }
  $targetFull = [IO.Path]::GetFullPath($target).TrimEnd('\')
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
  [Console]::Out.Write('ACL_NATIVE_REPARSE_PREFLIGHT=PASS')
  exit 0
}
catch {
  $message = [string]$_.Exception.Message
  if ($message -eq 'ACL_REPARSE_POINT_REFUSED') {
    [Console]::Out.Write('ACL_NATIVE_REPARSE_PREFLIGHT=REPARSE_POINT_REFUSED')
    exit 74
  }
  if (Test-AccessDeniedException $_) {
    [Console]::Out.Write('ACL_NATIVE_REPARSE_PREFLIGHT=ACCESS_DENIED')
    exit 75
  }
  if ($message -eq 'ACL_POWERSHELL_EXECUTABLE_REFUSED') {
    [Console]::Out.Write('ACL_NATIVE_REPARSE_PREFLIGHT=POWERSHELL_EXECUTABLE_REFUSED')
    exit 76
  }
  [Console]::Out.Write('ACL_NATIVE_REPARSE_PREFLIGHT=TARGET_VALIDATION_FAILED')
  exit 77
}
`;

const ACL_FULL_CONTROL = 2_032_127;
const ACL_ALLOW = 0;
const ACL_INHERIT_NONE = 0;
const ACL_INHERIT_CONTAINER_AND_OBJECT = 3;
const ACL_PROPAGATION_NONE = 0;

export function evaluateAclEvidence(inspection, currentUserSid, directory, options = {}) {
  const expectedSids = [currentUserSid, ACL_SYSTEM_SID].sort();
  const rules = Array.isArray(inspection?.rules)
    ? inspection.rules.map((rule) => ({
        sid: String(rule?.sid ?? ""),
        accessType: Number(rule?.accessType),
        rights: Number(rule?.rights),
        inheritance: Number(rule?.inheritance),
        propagation: Number(rule?.propagation),
        inherited: rule?.inherited === true,
      }))
    : [];
  const principals = [...new Set(rules.map((rule) => rule.sid))].sort();
  const expectedInheritance = directory ? ACL_INHERIT_CONTAINER_AND_OBJECT : ACL_INHERIT_NONE;
  const rulesMatch = (inherited) =>
    rules.length === expectedSids.length &&
    rules.every(
      (rule) =>
        expectedSids.includes(rule.sid) &&
        rule.accessType === ACL_ALLOW &&
        rule.rights === ACL_FULL_CONTROL &&
        rule.inheritance === expectedInheritance &&
        rule.propagation === ACL_PROPAGATION_NONE &&
        rule.inherited === inherited,
    ) &&
    expectedSids.every((sid) => rules.filter((rule) => rule.sid === sid).length === 1);
  const acceptedOwner =
    inspection?.ownerSid === currentUserSid ||
    (options.allowAdministrativeOwner === true &&
      [ACL_ADMINISTRATORS_SID, ACL_SYSTEM_SID].includes(inspection?.ownerSid));
  const exactProtected =
    inspection?.protected === true &&
    inspection?.ownerSid === currentUserSid &&
    inspection?.directory === directory &&
    inspection?.reparsePoint !== true &&
    rulesMatch(false);
  const exactInherited =
    options.allowInherited !== false &&
    inspection?.protected === false &&
    acceptedOwner &&
    inspection?.directory === directory &&
    inspection?.reparsePoint !== true &&
    typeof inspection?.protectedAncestor === "string" &&
    inspection.protectedAncestor.length > 0 &&
    rulesMatch(true);
  return Object.freeze({
    exactInherited,
    exactProtected,
    exactRestricted: exactProtected || exactInherited,
    ownerSid: inspection?.ownerSid,
    principals: Object.freeze(principals),
    rules: Object.freeze(rules.map((rule) => Object.freeze(rule))),
    directory,
    protected: inspection?.protected === true,
    protectedAncestor: inspection?.protectedAncestor ?? null,
    reparsePoint: inspection?.reparsePoint === true,
    verificationResult: exactProtected
      ? "EXACT_PROTECTED"
      : exactInherited
        ? "EXACT_INHERITED"
        : "MISMATCH",
  });
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    input: options.input,
    shell: false,
    windowsHide: true,
  });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

function getPowershellExecutable(options = {}) {
  return options.powershellExecutable ?? SYSTEM_WINDOWS_POWERSHELL;
}

function normalizePath(path) {
  return resolve(path)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function pathChain(root, target) {
  const chain = [root];
  const relationship = relative(root, target);
  if (!relationship) return chain;
  let cursor = root;
  for (const segment of relationship.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    chain.push(cursor);
  }
  return chain;
}

function isMissingPathError(error) {
  return error?.code === "ENOENT";
}

function lstatNoFollow(path, lstat = lstatSync) {
  try {
    return lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function volumeRootForPath(path) {
  const root = parse(resolve(path)).root;
  if (!root) throw new Error("ACL target does not have a valid volume root.");
  return root;
}

function validatePinnedSystemPowershell(options = {}) {
  const executable = resolve(options.nativePowershellExecutable ?? SYSTEM_WINDOWS_POWERSHELL);
  if (normalizePath(executable) !== normalizePath(SYSTEM_WINDOWS_POWERSHELL)) {
    throw new Error("ACL native validation requires the pinned system Windows PowerShell.");
  }
  const lstat = options.powershellLstat ?? lstatSync;
  for (const entry of pathChain(volumeRootForPath(executable), executable)) {
    const stat = lstatNoFollow(entry, lstat);
    if (!stat) {
      throw new Error("The pinned system Windows PowerShell is missing.");
    }
    if (stat.isSymbolicLink()) {
      throw new Error("The pinned system Windows PowerShell contains a reparse point.");
    }
  }
  const executableStat = lstatNoFollow(executable, lstat);
  if (!executableStat?.isFile()) {
    throw new Error("The pinned system Windows PowerShell is not a regular file.");
  }
  const realpath = options.powershellRealpath ?? realpathSync.native;
  if (normalizePath(realpath(executable)) !== normalizePath(SYSTEM_WINDOWS_POWERSHELL)) {
    throw new Error("The pinned system Windows PowerShell resolves unexpectedly.");
  }
  return executable;
}

function runNativeReparsePreflight(targetPath, options = {}) {
  const executable = validatePinnedSystemPowershell(options);
  const result = run(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      nativeReparsePreflightScript,
    ],
    { input: resolve(targetPath) },
  );
  if (result.exitCode !== 0 || result.stdout !== "ACL_NATIVE_REPARSE_PREFLIGHT=PASS") {
    const failureCategory = result.stdout.endsWith("=REPARSE_POINT_REFUSED")
      ? "REPARSE_POINT_REFUSED"
      : result.stdout.endsWith("=ACCESS_DENIED")
        ? "ACCESS_DENIED"
        : result.stdout.endsWith("=POWERSHELL_EXECUTABLE_REFUSED")
          ? "POWERSHELL_EXECUTABLE_REFUSED"
          : "TARGET_VALIDATION_FAILED";
    const error = new Error("ACL native reparse preflight failed: " + failureCategory);
    error.aclFailureCategory = failureCategory;
    error.aclCommandType = "WINDOWS_POWERSHELL_DOTNET_FILE_ATTRIBUTES_PREFLIGHT";
    error.aclExitCode = result.exitCode;
    throw error;
  }
  if (typeof options.nativeReparseCheck === "function") {
    const supplementalResult = options.nativeReparseCheck(resolve(targetPath));
    if (supplementalResult === false) {
      const error = new Error("ACL supplemental native reparse validation refused the target.");
      error.aclFailureCategory = "REPARSE_POINT_REFUSED";
      error.aclCommandType = "WINDOWS_POWERSHELL_DOTNET_FILE_ATTRIBUTES_PREFLIGHT";
      error.aclExitCode = 1;
      throw error;
    }
  }
}

function validateAclTargetNoFollow(targetPath, options = {}) {
  const requestedTarget = resolve(targetPath);
  const requestedRoot = resolve(options.allowedRoot ?? productionPaths.productRoot);
  const requestedValidationRoot = resolve(options.validationRoot ?? requestedRoot);
  const forbiddenRoot = resolve(options.forbiddenRoot ?? FORBIDDEN_REPOSITORY);
  if (isPathWithin(requestedTarget, forbiddenRoot)) {
    throw new Error("ACL target is inside the protected CPL repository.");
  }
  assertPathContained(requestedRoot, requestedTarget, "ACL target");
  assertPathContained(requestedValidationRoot, requestedTarget, "ACL validation target");
  const lstat = options.lstat ?? lstatSync;
  const reparsePaths = new Set((options.reparsePaths ?? []).map(normalizePath));
  for (const entry of pathChain(volumeRootForPath(requestedTarget), requestedTarget)) {
    if (reparsePaths.has(normalizePath(entry))) {
      throw new Error("ACL target contains a junction, symbolic link, or reparse point.");
    }
    const stat = lstatNoFollow(entry, lstat);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error("ACL target contains a junction, symbolic link, or reparse point.");
    }
  }
  return { forbiddenRoot, lstat, requestedRoot, requestedTarget };
}

function canonicalizeAclTarget(boundary, options = {}) {
  const { forbiddenRoot, lstat, requestedRoot, requestedTarget } = boundary;
  const realpath = options.realpath ?? realpathSync.native;
  const allowedRoot = lstatNoFollow(requestedRoot, lstat) ? realpath(requestedRoot) : requestedRoot;
  const target = lstatNoFollow(requestedTarget, lstat)
    ? realpath(requestedTarget)
    : requestedTarget;
  assertPathContained(allowedRoot, target, "ACL target");
  if (isPathWithin(target, forbiddenRoot)) {
    throw new Error("ACL target resolves inside the protected CPL repository.");
  }
  return Object.freeze({ allowedRoot, forbiddenRoot, target });
}

export function validateAclTarget(targetPath, options = {}) {
  return canonicalizeAclTarget(validateAclTargetNoFollow(targetPath, options), options);
}

function classifyAclValidationFailure(error) {
  if (typeof error?.aclFailureCategory === "string") return error.aclFailureCategory;
  const message = String(error?.message ?? error);
  if (error?.code === "EACCES" || error?.code === "EPERM") return "ACCESS_DENIED";
  if (/protected CPL repository/iu.test(message)) return "PROTECTED_REPOSITORY_REFUSED";
  if (/junction|symbolic link|reparse point/iu.test(message)) return "REPARSE_POINT_REFUSED";
  if (/inside|remain inside|contained/iu.test(message)) return "TARGET_OUTSIDE_ROOT";
  return "TARGET_VALIDATION_FAILED";
}

export function validateAclTargetForOperation(targetPath, options = {}) {
  try {
    const lexicalBoundary = validateAclTargetNoFollow(targetPath, options);
    if ((options.platform ?? process.platform) === "win32") {
      runNativeReparsePreflight(lexicalBoundary.requestedTarget, options);
    }
    return canonicalizeAclTarget(lexicalBoundary, options);
  } catch (error) {
    const failureCategory = classifyAclValidationFailure(error);
    throw createAclError({
      target: resolve(targetPath),
      stage: options.stage ?? "validation",
      commandType: error?.aclCommandType ?? "NODE_PATH_BOUNDARY_VALIDATION",
      exitCode: Number.isInteger(error?.aclExitCode) ? error.aclExitCode : 1,
      failureCategory,
      elevationRequired: failureCategory === "ACCESS_DENIED",
      verificationResult: "NOT_RUN",
    });
  }
}

export function classifyAclFailure(stderr, fallback = "COMMAND_FAILED") {
  const text = String(stderr ?? "");
  if (
    /CouldNotAutoloadMatchingModule|FormatXmlUpdateException|member .* is already present/iu.test(
      text,
    )
  ) {
    return "POWERSHELL_MODULE_AUTOLOAD_INCOMPATIBLE";
  }
  if (/access.+denied|unauthori[sz]ed|privilege/iu.test(text)) return "ACCESS_DENIED";
  if (/IdentityNotMapped|unknown.+sid/iu.test(text)) return "UNKNOWN_SID";
  return fallback;
}

function aclDiagnostic(values = {}) {
  return Object.freeze({
    AclTarget: values.target ?? "UNKNOWN",
    AclStage: values.stage ?? "UNKNOWN",
    AclOwnerBefore: values.ownerBefore ?? "UNKNOWN",
    AclInheritanceBefore: values.inheritanceBefore ?? "UNKNOWN",
    AclCommandType: values.commandType ?? "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR",
    AclExitCode: Number.isInteger(values.exitCode) ? values.exitCode : 1,
    AclFailureCategory: values.failureCategory ?? "COMMAND_FAILED",
    AclElevationRequired: values.elevationRequired === true,
    AclVerificationResult: values.verificationResult ?? "NOT_RUN",
    AclRollbackAttempted:
      values.rollbackAttempted === true
        ? true
        : values.rollbackAttempted === false
          ? false
          : "UNKNOWN",
    AclRollbackResult:
      values.rollbackSucceeded === true
        ? "PASS"
        : values.rollbackSucceeded === false
          ? "FAILED"
          : values.rollbackAttempted === false
            ? "NOT_RUN"
            : "UNKNOWN",
    ...(values.recoveryCommand ? { AclRecoveryCommand: values.recoveryCommand } : {}),
  });
}

function createAclError(values) {
  const evidence = aclDiagnostic(values);
  const message = [
    "Windows ACL enforcement failed closed.",
    ...Object.entries(evidence).map(([key, value]) => `${key}: ${String(value)}`),
  ].join("\n");
  const error = new Error(message);
  error.name = "WindowsAclError";
  error.evidence = evidence;
  return error;
}

function parseJsonEvidence(result, base, options = {}) {
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    const failureCategory =
      result.exitCode !== 0
        ? classifyAclFailure(result.stderr, options.nonzeroFallback ?? "COMMAND_FAILED")
        : "INVALID_JSON";
    throw createAclError({
      ...base,
      exitCode: result.exitCode,
      failureCategory,
      elevationRequired: base.elevationRequired === true || failureCategory === "ACCESS_DENIED",
    });
  }
}

function getValidationRoot(allowedRoot, target, options = {}) {
  if (options.validationRoot) return resolve(options.validationRoot);
  return normalizePath(allowedRoot) === normalizePath(target)
    ? resolve(options.productRootParent ?? dirname(dirname(allowedRoot)))
    : resolve(allowedRoot);
}

export function resolveCurrentUserSid(options = {}) {
  const runner = options.run ?? run;
  const powershell = options.powershellExecutable ?? validatePinnedSystemPowershell(options);
  const result = runner(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]);
  if (result.exitCode !== 0 || !sidPattern.test(result.stdout)) {
    throw new Error("The current Windows user SID could not be resolved.");
  }
  return result.stdout;
}

export function buildRestrictedAclPlan(targetPath, options = {}) {
  const boundary = validateAclTargetForOperation(targetPath, options);
  const sid = options.currentUserSid;
  if (!sidPattern.test(sid ?? "")) throw new Error("A valid current-user SID is required.");
  const directory =
    options.directory ?? (existsSync(boundary.target) && lstatSync(boundary.target).isDirectory());
  const input = {
    target: boundary.target,
    allowedRoot: boundary.allowedRoot,
    validationRoot: getValidationRoot(boundary.allowedRoot, boundary.target, options),
    forbiddenRoot: boundary.forbiddenRoot,
    currentUserSid: sid,
    directory,
    requireCanonicalProductRoot: options.requireCanonicalProductRoot === true,
    createIfMissing: options.createIfMissing === true,
    testOnlyForceVerificationFailure: options.testOnlyForceVerificationFailure === true,
  };
  return Object.freeze({
    target: boundary.target,
    allowedRoot: boundary.allowedRoot,
    directory,
    executable: getPowershellExecutable(options),
    input: JSON.stringify(input),
    commands: Object.freeze([
      Object.freeze([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        replaceAclScript,
      ]),
    ]),
    principals: Object.freeze([sid, ACL_SYSTEM_SID]),
    policy: options.policy ?? "secure-descendant",
  });
}

export async function applyRestrictedAcl(targetPath, options = {}) {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("Production ACL enforcement is supported only on Windows.");
  }
  const sid = options.currentUserSid ?? resolveCurrentUserSid(options);
  const plan = buildRestrictedAclPlan(targetPath, { ...options, currentUserSid: sid });
  if (options.dryRun === true) return { applied: false, changed: false, plan };
  const inspect = options.inspect ?? inspectAcl;
  const exists = options.exists ?? existsSync;
  const targetExists = exists(plan.target);
  if (!targetExists && options.createIfMissing !== true) {
    throw createAclError({
      target: plan.target,
      stage: "validation",
      commandType: "NODE_PATH_BOUNDARY_VALIDATION",
      exitCode: 1,
      failureCategory: "TARGET_MISSING",
    });
  }
  const before = targetExists
    ? inspect(plan.target, {
        ...options,
        allowedRoot: plan.allowedRoot,
        currentUserSid: sid,
        directory: plan.directory,
      })
    : Object.freeze({
        exactProtected: false,
        exactRestricted: false,
        ownerSid: "MISSING",
        protected: false,
        principals: Object.freeze([]),
        rules: Object.freeze([]),
        verificationResult: "NOT_RUN",
      });
  const requireProtected = ["product-root", "protected", "secret-file"].includes(plan.policy);
  if (requireProtected ? before.exactProtected : before.exactRestricted) {
    return {
      applied: false,
      changed: false,
      code: "ALREADY_COMPLIANT",
      inspection: before,
      plan,
    };
  }
  if (typeof options.confirm !== "function") {
    throw new Error("Explicit Owner confirmation is required before changing Windows ACLs.");
  }
  const confirmed = await options.confirm({
    action: "restrict-windows-acl",
    target: plan.target,
    grants: [sid, "SYSTEM"],
  });
  if (confirmed !== true) throw new Error("Owner declined the Windows ACL change.");

  const result = (options.runMutation ?? options.run ?? run)(plan.executable, plan.commands[0], {
    input: plan.input,
  });
  const targetRecoveryCommand =
    plan.policy === "product-root"
      ? ACL_STANDALONE_RECOVERY_COMMAND
      : ACL_CONFIGURE_RECOVERY_COMMAND;
  const base = {
    target: plan.target,
    stage: "inheritance-and-grant-replacement",
    ownerBefore: before.ownerSid,
    inheritanceBefore: before.protected ? "PROTECTED" : "ENABLED",
    commandType: "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR",
  };
  const output = parseJsonEvidence(result, base, { nonzeroFallback: "MUTATION_COMMAND_FAILED" });
  if (result.exitCode !== 0 || output.ok !== true) {
    const failureCategory =
      output.failureCategory ?? classifyAclFailure(result.stderr, "MUTATION_FAILED");
    throw createAclError({
      ...base,
      stage: output.stage ?? base.stage,
      ownerBefore: output.ownerBefore ?? base.ownerBefore,
      inheritanceBefore: output.inheritanceBefore ?? base.inheritanceBefore,
      exitCode: result.exitCode,
      failureCategory,
      elevationRequired: failureCategory === "ACCESS_DENIED",
      verificationResult: ["exact-verification", "secure-directory-verification"].includes(
        output.stage,
      )
        ? "FAILED"
        : "NOT_RUN",
      rollbackAttempted: output.rollbackAttempted,
      rollbackSucceeded: output.rollbackSucceeded,
      recoveryCommand:
        output.stage === "secure-directory-creation"
          ? ACL_CONFIGURE_RECOVERY_COMMAND
          : (output.rollbackAttempted === true && output.rollbackSucceeded === false) ||
              output.stage === "secure-directory-verification"
            ? targetRecoveryCommand
            : undefined,
    });
  }
  const after = evaluateAclEvidence(output.inspection, sid, plan.directory, {
    allowInherited: false,
  });
  if (!after.exactProtected) {
    throw createAclError({
      ...base,
      stage: "exact-verification",
      exitCode: result.exitCode,
      failureCategory: "EXACT_VERIFICATION_FAILED",
      verificationResult: "FAILED",
      rollbackAttempted: output.rollbackAttempted,
      rollbackSucceeded: output.rollbackSucceeded,
      recoveryCommand: targetRecoveryCommand,
    });
  }
  return {
    applied: true,
    changed: true,
    code: "REPAIRED",
    inspection: after,
    plan,
    rollbackAttempted: false,
  };
}

export function inspectAcl(targetPath, options = {}) {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("Production ACL inspection is supported only on Windows.");
  }
  const boundary = validateAclTargetForOperation(targetPath, {
    ...options,
    stage: "inspection-validation",
  });
  const currentUserSid = options.currentUserSid ?? resolveCurrentUserSid(options);
  const directory =
    options.directory ?? (existsSync(boundary.target) && lstatSync(boundary.target).isDirectory());
  const executable = getPowershellExecutable(options);
  const result = (options.run ?? run)(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", inspectAclScript],
    {
      input: JSON.stringify({
        target: boundary.target,
        allowedRoot: boundary.allowedRoot,
        validationRoot: getValidationRoot(boundary.allowedRoot, boundary.target, options),
        forbiddenRoot: boundary.forbiddenRoot,
        directory,
      }),
    },
  );
  const base = {
    target: boundary.target,
    stage: "inspection",
    commandType: "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR",
    exitCode: result.exitCode,
  };
  const inspection = parseJsonEvidence(result, base, { nonzeroFallback: "INSPECTION_FAILED" });
  if (result.exitCode !== 0 || inspection.ok !== true) {
    const failureCategory =
      inspection.failureCategory ?? classifyAclFailure(result.stderr, "INSPECTION_FAILED");
    throw createAclError({
      ...base,
      failureCategory,
      elevationRequired: failureCategory === "ACCESS_DENIED",
    });
  }
  const evidence = evaluateAclEvidence(inspection, currentUserSid, directory, options);
  return Object.freeze({
    target: boundary.target,
    text: result.stdout,
    inspection: Object.freeze(inspection),
    ...evidence,
  });
}

const elevationWrapperScript = String.raw`
$ErrorActionPreference = 'Stop'
function Test-PathEqual([string]$Left, [string]$Right) {
  return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals(
    [IO.Path]::GetFullPath($Right).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase
  )
}
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $systemPowerShell = [IO.Path]::Combine(
    [Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
  if (-not (Test-PathEqual ([string]$inputData.executable) $systemPowerShell)) {
    throw 'ACL_POWERSHELL_EXECUTABLE_REFUSED'
  }
  $attributes = [IO.File]::GetAttributes($systemPowerShell)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'ACL_POWERSHELL_EXECUTABLE_REFUSED'
  }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $systemPowerShell
  $startInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [string]$inputData.encodedCommand
  $startInfo.UseShellExecute = $true
  $startInfo.Verb = 'runas'
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = [Diagnostics.Process]::Start($startInfo)
  $process.WaitForExit()
  [ordered]@{
    ok = $process.ExitCode -eq 0
    exitCode = [int]$process.ExitCode
    failureCategory = if ($process.ExitCode -eq 0) { $null } else { 'ELEVATED_HELPER_FAILED' }
  } | ConvertTo-Json -Compress | Write-Output
}
catch [ComponentModel.Win32Exception] {
  [ordered]@{
    ok = $false
    exitCode = [int]$_.Exception.NativeErrorCode
    failureCategory = if ($_.Exception.NativeErrorCode -eq 1223) { 'UAC_DECLINED' } else { 'ELEVATION_LAUNCH_FAILED' }
  } | ConvertTo-Json -Compress | Write-Output
}
catch {
  [ordered]@{ ok = $false; exitCode = 1; failureCategory = 'ELEVATION_LAUNCH_FAILED' } |
    ConvertTo-Json -Compress | Write-Output
}
`;

const ELEVATED_EXIT_MAGIC = 0xa000;
const ELEVATED_EXIT_MAGIC_MASK = 0xf000;
const elevatedStages = Object.freeze({
  1: "validation",
  2: "capture",
  3: "inheritance-and-grant-replacement",
  4: "owner-assignment",
  5: "exact-verification",
  6: "secure-directory-creation",
  7: "secure-directory-verification",
  8: "helper-internal",
});
const elevatedCategories = Object.freeze({
  1: "TARGET_OUTSIDE_ROOT",
  2: "PROTECTED_REPOSITORY_REFUSED",
  3: "REPARSE_POINT_REFUSED",
  4: "SID_MISMATCH",
  5: "UNKNOWN_SID",
  6: "TARGET_MISSING",
  7: "ACCESS_DENIED",
  8: "DESCRIPTOR_CAPTURE_FAILED",
  9: "MUTATION_FAILED",
  10: "EXACT_VERIFICATION_FAILED",
  11: "HELPER_INTERNAL_FAILURE",
  12: "DIRECTORY_CREATION_FAILED",
});

export function decodeElevatedAclExitCode(exitCode) {
  if (
    !Number.isInteger(exitCode) ||
    (exitCode & ELEVATED_EXIT_MAGIC_MASK) !== ELEVATED_EXIT_MAGIC
  ) {
    return undefined;
  }
  const stage = elevatedStages[(exitCode >> 8) & 0x0f];
  const failureCategory = elevatedCategories[(exitCode >> 2) & 0x3f];
  const rollbackId = exitCode & 0x03;
  if (!stage || !failureCategory || rollbackId === 3) return undefined;
  const validCategories = {
    validation: [
      "TARGET_OUTSIDE_ROOT",
      "PROTECTED_REPOSITORY_REFUSED",
      "REPARSE_POINT_REFUSED",
      "SID_MISMATCH",
      "UNKNOWN_SID",
      "TARGET_MISSING",
      "ACCESS_DENIED",
    ],
    capture: ["ACCESS_DENIED", "DESCRIPTOR_CAPTURE_FAILED"],
    "inheritance-and-grant-replacement": [
      "REPARSE_POINT_REFUSED",
      "ACCESS_DENIED",
      "MUTATION_FAILED",
    ],
    "owner-assignment": ["REPARSE_POINT_REFUSED", "ACCESS_DENIED", "MUTATION_FAILED"],
    "exact-verification": [
      "REPARSE_POINT_REFUSED",
      "ACCESS_DENIED",
      "MUTATION_FAILED",
      "EXACT_VERIFICATION_FAILED",
    ],
    "secure-directory-creation": [
      "REPARSE_POINT_REFUSED",
      "ACCESS_DENIED",
      "DIRECTORY_CREATION_FAILED",
    ],
    "secure-directory-verification": [
      "REPARSE_POINT_REFUSED",
      "ACCESS_DENIED",
      "MUTATION_FAILED",
      "EXACT_VERIFICATION_FAILED",
    ],
    "helper-internal": ["HELPER_INTERNAL_FAILURE"],
  }[stage];
  if (!validCategories.includes(failureCategory)) return undefined;
  const noRollbackStage = [
    "validation",
    "capture",
    "secure-directory-creation",
    "secure-directory-verification",
    "helper-internal",
  ].includes(stage);
  const requiresRollbackStage = ["owner-assignment", "exact-verification"].includes(stage);
  if ((noRollbackStage && rollbackId !== 0) || (requiresRollbackStage && rollbackId === 0)) {
    return undefined;
  }
  const rollbackAttempted = rollbackId !== 0;
  return Object.freeze({
    stage,
    failureCategory,
    rollbackAttempted,
    rollbackSucceeded: rollbackId === 1 ? true : rollbackId === 2 ? false : undefined,
    verificationResult:
      stage === "exact-verification" ||
      stage === "secure-directory-verification" ||
      failureCategory === "EXACT_VERIFICATION_FAILED"
        ? "FAILED"
        : "NOT_RUN",
  });
}

export function buildElevatedProductRootRepairRequest(targetPath, options = {}) {
  const canonicalProductRoot = resolve(options.productRoot ?? productionPaths.productRoot);
  const target = resolve(targetPath);
  if (normalizePath(target) !== normalizePath(canonicalProductRoot)) {
    throw new Error("Elevated ACL repair is restricted to the canonical BEA CommandCenter root.");
  }
  const sid = options.currentUserSid;
  if (!sidPattern.test(sid ?? "")) throw new Error("A valid initiating-user SID is required.");
  const executable = validatePinnedSystemPowershell({
    ...options,
    nativePowershellExecutable: options.powershellExecutable ?? SYSTEM_WINDOWS_POWERSHELL,
  });
  const plan = buildRestrictedAclPlan(target, {
    ...options,
    powershellExecutable: executable,
    allowedRoot: canonicalProductRoot,
    currentUserSid: sid,
    directory: true,
    policy: "product-root",
    requireCanonicalProductRoot: true,
  });
  const payload = Buffer.from(plan.input, "utf8").toString("base64");
  const embeddedInput = `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`;
  const elevatedSource = replaceAclScript.replace(
    "$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    embeddedInput,
  );
  const compressedSource = gzipSync(Buffer.from(elevatedSource, "utf8")).toString("base64");
  const compressedLauncher = String.raw`
$compressed = [Convert]::FromBase64String('${compressedSource}')
$memory = [IO.MemoryStream]::new(,$compressed)
$gzip = [IO.Compression.GzipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
try { & ([ScriptBlock]::Create($reader.ReadToEnd())) }
finally { $reader.Dispose(); $gzip.Dispose(); $memory.Dispose() }
`;
  return Object.freeze({
    target,
    currentUserSid: sid,
    executable: plan.executable,
    commandType: "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR_ELEVATED",
    argumentCategory: "NO_PROFILE_NONINTERACTIVE_PROCESS_ONLY_POLICY_ENCODED_HELPER",
    payloadCategory: "GZIP_BASE64_EMBEDDED_DOTNET_ACL_HELPER",
    encodedCommand: Buffer.from(compressedLauncher, "utf16le").toString("base64"),
    wrapperArguments: Object.freeze([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      elevationWrapperScript,
    ]),
  });
}

export async function repairProductRootAclElevated(targetPath, options = {}) {
  const sid = options.currentUserSid ?? resolveCurrentUserSid(options);
  const request = buildElevatedProductRootRepairRequest(targetPath, {
    ...options,
    currentUserSid: sid,
  });
  const result = (options.runElevated ?? options.run ?? run)(
    request.executable,
    request.wrapperArguments,
    {
      input: JSON.stringify({
        executable: request.executable,
        encodedCommand: request.encodedCommand,
      }),
    },
  );
  const base = {
    target: request.target,
    stage: "elevation",
    ownerBefore: options.ownerBefore,
    inheritanceBefore: options.inheritanceBefore,
    commandType: request.commandType,
    elevationRequired: true,
  };
  const output = parseJsonEvidence(result, base, { nonzeroFallback: "ELEVATION_LAUNCH_FAILED" });
  const childExitCode = Number.isInteger(output.exitCode) ? output.exitCode : result.exitCode;
  if (result.exitCode !== 0 || output.ok !== true || childExitCode !== 0) {
    const childEvidence = decodeElevatedAclExitCode(childExitCode);
    const childReportedFailure = output.failureCategory === "ELEVATED_HELPER_FAILED";
    const failureCategory = childReportedFailure
      ? (childEvidence?.failureCategory ?? "ELEVATED_HELPER_FAILED")
      : (output.failureCategory ?? childEvidence?.failureCategory ?? "ELEVATED_HELPER_FAILED");
    const stage = childReportedFailure
      ? (childEvidence?.stage ?? "elevated-repair")
      : output.failureCategory === "UAC_DECLINED" ||
          output.failureCategory === "ELEVATION_LAUNCH_FAILED"
        ? "elevation"
        : (childEvidence?.stage ?? "elevated-repair");
    throw createAclError({
      ...base,
      stage,
      exitCode: childExitCode,
      failureCategory,
      elevationRequired: true,
      verificationResult: childEvidence?.verificationResult ?? "NOT_RUN",
      rollbackAttempted: childReportedFailure ? childEvidence?.rollbackAttempted : false,
      rollbackSucceeded: childEvidence?.rollbackSucceeded,
      recoveryCommand:
        childEvidence?.stage === "secure-directory-creation"
          ? ACL_CONFIGURE_RECOVERY_COMMAND
          : childEvidence?.rollbackSucceeded === false ||
              childEvidence?.stage === "secure-directory-verification"
            ? ACL_STANDALONE_RECOVERY_COMMAND
            : undefined,
    });
  }
  const after = (options.inspect ?? inspectAcl)(request.target, {
    ...options,
    allowedRoot: options.productRoot ?? productionPaths.productRoot,
    currentUserSid: sid,
    directory: true,
    allowInherited: false,
  });
  if (!after.exactProtected) {
    throw createAclError({
      ...base,
      stage: "exact-verification",
      exitCode: childExitCode,
      failureCategory: "EXACT_VERIFICATION_FAILED",
      elevationRequired: true,
      verificationResult: "FAILED",
      recoveryCommand: ACL_STANDALONE_RECOVERY_COMMAND,
    });
  }
  return { applied: true, changed: true, code: "REPAIRED_ELEVATED", inspection: after, request };
}

function rollbackValuesFromEvidence(evidence) {
  return {
    rollbackAttempted:
      evidence?.AclRollbackAttempted === true
        ? true
        : evidence?.AclRollbackAttempted === false
          ? false
          : undefined,
    rollbackSucceeded:
      evidence?.AclRollbackResult === "PASS"
        ? true
        : evidence?.AclRollbackResult === "FAILED"
          ? false
          : undefined,
  };
}

function preserveAclRecoveryEvidence(error, priorError, recoveryCommand) {
  const evidence = error?.evidence ?? {};
  const priorEvidence = priorError?.evidence ?? {};
  const priorRollbackFailed = priorEvidence.AclRollbackResult === "FAILED";
  const rollback = rollbackValuesFromEvidence(evidence);
  const priorRollback = rollbackValuesFromEvidence(priorEvidence);
  return createAclError({
    target: evidence.AclTarget ?? priorEvidence.AclTarget,
    stage: evidence.AclStage ?? priorEvidence.AclStage,
    ownerBefore: evidence.AclOwnerBefore ?? priorEvidence.AclOwnerBefore,
    inheritanceBefore: evidence.AclInheritanceBefore ?? priorEvidence.AclInheritanceBefore,
    commandType: evidence.AclCommandType ?? priorEvidence.AclCommandType,
    exitCode: Number.isInteger(evidence.AclExitCode)
      ? evidence.AclExitCode
      : priorEvidence.AclExitCode,
    failureCategory:
      evidence.AclFailureCategory ?? priorEvidence.AclFailureCategory ?? "COMMAND_FAILED",
    elevationRequired:
      evidence.AclElevationRequired === true || priorEvidence.AclElevationRequired === true,
    verificationResult:
      evidence.AclVerificationResult ?? priorEvidence.AclVerificationResult ?? "NOT_RUN",
    rollbackAttempted: priorRollbackFailed
      ? true
      : (rollback.rollbackAttempted ?? priorRollback.rollbackAttempted),
    rollbackSucceeded: priorRollbackFailed
      ? false
      : (rollback.rollbackSucceeded ?? priorRollback.rollbackSucceeded),
    recoveryCommand:
      priorEvidence.AclRecoveryCommand ?? evidence.AclRecoveryCommand ?? recoveryCommand,
  });
}

function unknownAclInspection(ownerSid = "UNKNOWN") {
  return Object.freeze({
    exactProtected: false,
    exactRestricted: false,
    ownerSid,
    protected: false,
    principals: Object.freeze([]),
    rules: Object.freeze([]),
    verificationResult: "NOT_RUN",
  });
}

export function formatProductRootRepairPrompt(plan) {
  const inherited = plan.inspection.rules
    .filter((rule) => rule.inherited)
    .map((rule) => rule.sid)
    .sort();
  return [
    "BEA Windows permissions repair required.",
    `AclTarget: ${plan.target}`,
    `AclOwnerBefore: ${plan.inspection.ownerSid ?? "UNKNOWN"}`,
    `AclInheritanceBefore: ${plan.inspection.protected ? "PROTECTED" : "ENABLED"}`,
    `AclInheritedIdentities: ${inherited.length > 0 ? inherited.join(", ") : "NONE"}`,
    `AclDesiredOwner: ${plan.currentUserSid}`,
    `AclDesiredGrants: ${plan.currentUserSid}=FullControl; ${ACL_SYSTEM_SID}=FullControl`,
    `AclElevationRequired: ${
      plan.elevationRequired
        ? "YES - one-time helper only"
        : plan.elevationConditional
          ? "NO initially - normal repair first; UAC only after structured access denial"
          : "NO"
    }`,
    `AclScope: only ${plan.target} is directly rewritten; parent BEA ACL and file bytes are preserved. Protected descendant ACLs remain unchanged; unprotected descendants inherit the new restricted grants.`,
    "AclRollback: owner and DACL are held in memory, verified after repair, and restored on failure where safely possible.",
    `Type ${ACL_REPAIR_APPROVAL} to continue: `,
  ].join("\n");
}

export async function ensureProductionAclBootstrap(options = {}) {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("Production ACL bootstrap is supported only on Windows.");
  }
  const paths = options.paths ?? productionPaths;
  const sid = options.currentUserSid ?? resolveCurrentUserSid(options);
  const exists = options.exists ?? existsSync;
  const inspect = options.inspect ?? inspectAcl;
  const productRootParent = options.productRootParent ?? dirname(dirname(paths.productRoot));
  const rootOptions = {
    ...options,
    allowedRoot: paths.productRoot,
    validationRoot: productRootParent,
    productRootParent,
    currentUserSid: sid,
    directory: true,
    allowInherited: false,
  };
  validateAclTargetForOperation(paths.productRoot, {
    ...rootOptions,
    stage: "product-root-preflight",
  });
  const rootExisted = exists(paths.productRoot);
  let initialInspectionError;
  let rootInspection;
  if (rootExisted) {
    try {
      rootInspection = inspect(paths.productRoot, rootOptions);
    } catch (error) {
      if (error?.evidence?.AclFailureCategory !== "ACCESS_DENIED") throw error;
      initialInspectionError = preserveAclRecoveryEvidence(
        error,
        undefined,
        ACL_STANDALONE_RECOVERY_COMMAND,
      );
      rootInspection = unknownAclInspection("UNKNOWN_ACCESS_DENIED");
    }
  } else {
    rootInspection = unknownAclInspection("MISSING");
  }
  let rootResult = { code: "ALREADY_COMPLIANT" };
  if (!rootInspection.exactProtected) {
    const initialRepairInspection = rootInspection;
    const repairPlan = Object.freeze({
      target: paths.productRoot,
      currentUserSid: sid,
      inspection: rootInspection,
      elevationRequired: initialInspectionError !== undefined,
      elevationConditional:
        initialInspectionError === undefined && rootExisted && rootInspection.ownerSid !== sid,
    });
    const approval = await (options.prompt ?? (async () => ""))(
      formatProductRootRepairPrompt(repairPlan),
    );
    if (approval !== ACL_REPAIR_APPROVAL) {
      if (initialInspectionError) throw initialInspectionError;
      throw new Error("Owner declined the BEA permissions repair.");
    }
    if (initialInspectionError) {
      try {
        rootResult = await (options.repairElevated ?? repairProductRootAclElevated)(
          paths.productRoot,
          {
            ...rootOptions,
            productRoot: paths.productRoot,
            createIfMissing: false,
            ownerBefore: rootInspection.ownerSid,
            inheritanceBefore: "UNKNOWN",
            inspect,
          },
        );
      } catch (error) {
        throw preserveAclRecoveryEvidence(
          error,
          initialInspectionError,
          ACL_STANDALONE_RECOVERY_COMMAND,
        );
      }
    } else {
      try {
        rootResult = await (options.repairNormal ?? applyRestrictedAcl)(paths.productRoot, {
          ...rootOptions,
          policy: "product-root",
          createIfMissing: !rootExisted,
          inspect,
          confirm: async () => true,
        });
      } catch (error) {
        const category = error?.evidence?.AclFailureCategory;
        const rollbackFailed = error?.evidence?.AclRollbackResult === "FAILED";
        if (category !== "ACCESS_DENIED" && !rollbackFailed) throw error;
        const normalRecoveryCommand =
          error?.evidence?.AclRecoveryCommand ??
          (error?.evidence?.AclStage === "secure-directory-creation"
            ? ACL_CONFIGURE_RECOVERY_COMMAND
            : ACL_STANDALONE_RECOVERY_COMMAND);
        const fallbackError = preserveAclRecoveryEvidence(error, undefined, normalRecoveryCommand);
        let elevatedInspection = rootInspection;
        if (rollbackFailed) {
          try {
            elevatedInspection = inspect(paths.productRoot, rootOptions);
          } catch {
            elevatedInspection = unknownAclInspection("UNKNOWN_AFTER_FAILED_ROLLBACK");
          }
        }
        const elevatedPlan = Object.freeze({
          ...repairPlan,
          inspection: elevatedInspection,
          elevationRequired: true,
          elevationConditional: false,
        });
        const elevatedApproval = await (options.prompt ?? (async () => ""))(
          formatProductRootRepairPrompt(elevatedPlan),
        );
        if (elevatedApproval !== ACL_REPAIR_APPROVAL) throw fallbackError;
        try {
          rootResult = await (options.repairElevated ?? repairProductRootAclElevated)(
            paths.productRoot,
            {
              ...rootOptions,
              productRoot: paths.productRoot,
              createIfMissing: !rootExisted,
              ownerBefore: elevatedInspection.ownerSid,
              inheritanceBefore: elevatedInspection.protected ? "PROTECTED" : "UNKNOWN",
              inspect,
            },
          );
        } catch (elevatedError) {
          throw preserveAclRecoveryEvidence(elevatedError, fallbackError, normalRecoveryCommand);
        }
      }
    }
    try {
      rootInspection = inspect(paths.productRoot, rootOptions);
    } catch (error) {
      throw preserveAclRecoveryEvidence(
        error,
        initialInspectionError,
        ACL_STANDALONE_RECOVERY_COMMAND,
      );
    }
    if (!rootInspection.exactProtected) {
      throw createAclError({
        target: paths.productRoot,
        stage: "exact-verification",
        ownerBefore: initialRepairInspection.ownerSid,
        inheritanceBefore: initialRepairInspection.protected ? "PROTECTED" : "ENABLED",
        exitCode: 0,
        failureCategory: "EXACT_VERIFICATION_FAILED",
        elevationRequired: rootResult.code === "REPAIRED_ELEVATED",
        verificationResult: "FAILED",
        recoveryCommand: ACL_STANDALONE_RECOVERY_COMMAND,
      });
    }
  }

  const secureDirectories = [
    paths.configDirectory,
    paths.secretDirectory,
    paths.runtimeDirectory,
    paths.logDirectory,
    paths.certificateDirectory,
    paths.backupDirectory,
  ];
  const apply = options.applyAcl ?? applyRestrictedAcl;
  for (const directory of secureDirectories) {
    await apply(directory, {
      ...options,
      allowedRoot: paths.productRoot,
      validationRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      policy: [paths.configDirectory, paths.secretDirectory, paths.certificateDirectory].includes(
        directory,
      )
        ? "protected"
        : "secure-descendant",
      allowInherited: true,
      createIfMissing: !exists(directory),
      confirm: async () => true,
    });
  }
  for (const directory of secureDirectories) {
    const requiresExactProtection = [
      paths.configDirectory,
      paths.secretDirectory,
      paths.certificateDirectory,
    ].includes(directory);
    const evidence = inspect(directory, {
      ...options,
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      allowInherited: !requiresExactProtection,
    });
    if (requiresExactProtection ? !evidence.exactProtected : !evidence.exactRestricted) {
      throw createAclError({
        target: directory,
        stage: "exact-verification",
        ownerBefore: evidence.ownerSid,
        inheritanceBefore: evidence.protected ? "PROTECTED" : "ENABLED",
        exitCode: 0,
        failureCategory: "EXACT_VERIFICATION_FAILED",
        verificationResult: "FAILED",
      });
    }
  }
  return Object.freeze({
    code: rootResult.code,
    currentUserSid: sid,
    root: rootInspection,
    directories: Object.freeze([...secureDirectories]),
    elevationUsed: rootResult.code === "REPAIRED_ELEVATED",
  });
}
