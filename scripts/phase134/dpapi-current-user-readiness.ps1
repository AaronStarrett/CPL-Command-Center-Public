$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This helper performs one non-persisted Windows DPAPI CurrentUser readiness
# round trip. It accepts only an intended SID and emits only bounded status
# evidence; plaintext and ciphertext never leave this process.

$schemaVersion = 1
$provider = 'windows-dpapi-current-user'
$runtimeExecutable = [IO.Path]::GetFullPath([IO.Path]::Combine($PSHOME, 'powershell.exe'))
$runtimeVersion = $PSVersionTable.PSVersion.ToString()
$currentUserSid = 'UNKNOWN'
$currentTokenElevated = $null
$userProfileLoaded = $false
$protectSucceeded = $false
$unprotectSucceeded = $false
$roundTripMatched = $false
$failureCategory = 'NONE'
$exitCode = 0
$probe = $null
$ciphertext = $null
$roundTrip = $null
$jsonAssembly = [Reflection.Assembly]::Load(
  'System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'
)
$jsonType = $jsonAssembly.GetType(
  'System.Web.Script.Serialization.JavaScriptSerializer',
  $true
)
$serializer = [Activator]::CreateInstance($jsonType)

try {
  $inputText = [Console]::In.ReadToEnd()
  try {
    $inputData = $serializer.DeserializeObject($inputText)
  }
  catch {
    $failureCategory = 'MALFORMED_HELPER_INPUT'
    $exitCode = 2
    throw
  }

  if (
    $null -eq $inputData -or
    -not ($inputData -is [Collections.IDictionary]) -or
    $inputData.Count -ne 2 -or
    -not $inputData.ContainsKey('schemaVersion') -or
    -not $inputData.ContainsKey('intendedUserSid') -or
    $inputData['schemaVersion'] -ne $schemaVersion -or
    [string]$inputData['intendedUserSid'] -notmatch '^S-\d-(?:\d+-){1,14}\d+$'
  ) {
    $failureCategory = 'MALFORMED_HELPER_INPUT'
    $exitCode = 2
    throw 'DPAPI_READINESS_ABORT'
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity -or $null -eq $identity.User) {
    $failureCategory = 'IDENTITY_UNAVAILABLE'
    $exitCode = 3
    throw 'DPAPI_READINESS_ABORT'
  }
  $currentUserSid = $identity.User.Value
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $currentTokenElevated = $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
  if ($currentUserSid -ne [string]$inputData['intendedUserSid']) {
    $failureCategory = 'IDENTITY_MISMATCH'
    $exitCode = 4
    throw 'DPAPI_READINESS_ABORT'
  }
  if ($currentTokenElevated) {
    $failureCategory = 'ELEVATED_TOKEN_REFUSED'
    $exitCode = 7
    throw 'DPAPI_READINESS_ABORT'
  }

  $userProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $profileDirectoryReady = -not [string]::IsNullOrWhiteSpace($userProfilePath) -and
    [IO.Directory]::Exists($userProfilePath)
  $usersHive = $null
  $sidHive = $null
  try {
    $usersHive = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::Users,
      [Microsoft.Win32.RegistryView]::Default
    )
    $sidHive = $usersHive.OpenSubKey($currentUserSid, $false)
    $userProfileLoaded = $profileDirectoryReady -and $null -ne $sidHive
  }
  finally {
    if ($null -ne $sidHive) { $sidHive.Dispose() }
    if ($null -ne $usersHive) { $usersHive.Dispose() }
  }
  if (-not $userProfileLoaded) {
    $failureCategory = 'USER_PROFILE_UNAVAILABLE'
    $exitCode = 5
    throw 'DPAPI_READINESS_ABORT'
  }

  try {
    $securityAssembly = [Reflection.Assembly]::Load(
      'System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
    )
  }
  catch {
    $failureCategory = 'CRYPTOGRAPHY_RUNTIME_UNAVAILABLE'
    $exitCode = 6
    throw
  }

  $probe = [byte[]]::new(32)
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($probe)
  }
  finally {
    $random.Dispose()
  }

  try {
    $ciphertext = [Security.Cryptography.ProtectedData]::Protect(
      $probe,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $protectSucceeded = $true
  }
  catch {
    $failureCategory = 'PROTECT_FAILED'
    $exitCode = 13
    throw
  }

  try {
    $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect(
      $ciphertext,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $unprotectSucceeded = $true
  }
  catch {
    $failureCategory = 'UNPROTECT_FAILED'
    $exitCode = 14
    throw
  }

  # Compare every probe byte and fold the length difference into the result.
  # Runtime depends only on the fixed probe size, never on byte values.
  $difference = $probe.Length -bxor $roundTrip.Length
  for ($index = 0; $index -lt $probe.Length; $index += 1) {
    $right = if ($index -lt $roundTrip.Length) { $roundTrip[$index] } else { 0 }
    $difference = $difference -bor ($probe[$index] -bxor $right)
  }
  $roundTripMatched = $difference -eq 0
  if (-not $roundTripMatched) {
    $failureCategory = 'ROUND_TRIP_MISMATCH'
    $exitCode = 15
    throw 'DPAPI_READINESS_ABORT'
  }
}
catch {
  if ($failureCategory -eq 'NONE') {
    $failureCategory = 'HELPER_INTERNAL_FAILURE'
    $exitCode = 16
  }
}
finally {
  if ($null -ne $probe) { [Array]::Clear($probe, 0, $probe.Length) }
  if ($null -ne $ciphertext) { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
  if ($null -ne $roundTrip) { [Array]::Clear($roundTrip, 0, $roundTrip.Length) }
}

$evidence = [ordered]@{
  schemaVersion = $schemaVersion
  provider = $provider
  runtimeExecutable = $runtimeExecutable
  runtimeVersion = $runtimeVersion
  currentUserSid = $currentUserSid
  currentTokenElevated = $currentTokenElevated
  userProfileLoaded = [bool]$userProfileLoaded
  protectSucceeded = [bool]$protectSucceeded
  unprotectSucceeded = [bool]$unprotectSucceeded
  roundTripMatched = [bool]$roundTripMatched
  probePersisted = $false
  probeOutput = $false
  failureCategory = $failureCategory
}
[Console]::Out.WriteLine($serializer.Serialize($evidence))
exit $exitCode
