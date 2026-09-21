import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertPathContained, productionPaths } from "./production-paths.mjs";
import { isLoopbackSafeHostname } from "./production-profile.mjs";

export const CERTIFICATE_METADATA_VERSION = 1;
export const REQUIRED_LOCAL_SANS = Object.freeze([
  "bea.localhost",
  "localhost",
  "127.0.0.1",
  "::1",
]);

const certificateMetadataKeys = Object.freeze([
  "schemaVersion",
  "hostname",
  "subject",
  "issuer",
  "certificateThumbprint",
  "rootThumbprint",
  "sans",
  "notBefore",
  "notAfter",
  "trustStore",
  "privateKeyStore",
  "pfxPath",
  "rootCertificatePath",
]);

const setupScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$rootNotAfter = [DateTime]::UtcNow.AddYears(5)
$leafNotAfter = [DateTime]::UtcNow.AddDays([int]$inputData.validityDays)
$root = New-SelfSignedCertificate -Type Custom -Subject 'CN=BEA Local Production Root' -FriendlyName 'BEA Local Production Root' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign,DigitalSignature -NotAfter $rootNotAfter -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')
$rootStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
try {
  $rootStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $rootStore.Add($root)
}
finally { $rootStore.Close() }
$san = '2.5.29.17={text}DNS=' + $inputData.hostname + '&DNS=localhost&IPAddress=127.0.0.1&IPAddress=::1'
$leaf = New-SelfSignedCertificate -Type Custom -Subject ('CN=' + $inputData.hostname) -FriendlyName 'BEA Local Live Production' -Signer $root -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -NotAfter $leafNotAfter -TextExtension @($san, '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
$password = ConvertTo-SecureString -String ([string]$inputData.pfxPassword) -AsPlainText -Force
Export-PfxCertificate -Cert $leaf -FilePath ([string]$inputData.pfxPath) -Password $password -ChainOption BuildChain -Force | Out-Null
Export-Certificate -Cert $root -FilePath ([string]$inputData.rootCertificatePath) -Type CERT -Force | Out-Null
[ordered]@{
  schemaVersion = 1
  hostname = [string]$inputData.hostname
  subject = $leaf.Subject
  issuer = $leaf.Issuer
  certificateThumbprint = $leaf.Thumbprint
  rootThumbprint = $root.Thumbprint
  sans = @([string]$inputData.hostname, 'localhost', '127.0.0.1', '::1')
  notBefore = $leaf.NotBefore.ToUniversalTime().ToString('o')
  notAfter = $leaf.NotAfter.ToUniversalTime().ToString('o')
  trustStore = 'Cert:\CurrentUser\Root'
  privateKeyStore = 'Cert:\CurrentUser\My'
  pfxPath = [string]$inputData.pfxPath
  rootCertificatePath = [string]$inputData.rootCertificatePath
} | ConvertTo-Json -Depth 5 -Compress | Write-Output
`;

const trustInspectionScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Normalize-Thumbprint([object]$value) {
  return ([string]$value).Replace(' ', '').ToUpperInvariant()
}
function Read-DerLength([byte[]]$bytes, [ref]$offset) {
  if ($offset.Value -ge $bytes.Length) { throw 'Malformed DER length.' }
  $first = [int]$bytes[$offset.Value]
  $offset.Value += 1
  if (($first -band 0x80) -eq 0) { return $first }
  $count = $first -band 0x7f
  if ($count -lt 1 -or $count -gt 4 -or $offset.Value + $count -gt $bytes.Length) {
    throw 'Malformed DER length.'
  }
  $length = 0
  for ($index = 0; $index -lt $count; $index += 1) {
    $length = ($length -shl 8) -bor [int]$bytes[$offset.Value]
    $offset.Value += 1
  }
  return $length
}
function Read-SubjectAlternativeNames([Security.Cryptography.X509Certificates.X509Certificate2]$certificate) {
  $extension = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' })
  if ($extension.Count -ne 1) { throw 'The leaf certificate must have one SAN extension.' }
  [byte[]]$raw = $extension[0].RawData
  $offset = 0
  if ($raw.Length -lt 2 -or $raw[$offset] -ne 0x30) { throw 'The SAN extension is malformed.' }
  $offset += 1
  $sequenceLength = Read-DerLength $raw ([ref]$offset)
  $sequenceEnd = $offset + $sequenceLength
  if ($sequenceEnd -ne $raw.Length) { throw 'The SAN extension has trailing or truncated data.' }
  $names = @()
  while ($offset -lt $sequenceEnd) {
    $tag = [int]$raw[$offset]
    $offset += 1
    $length = Read-DerLength $raw ([ref]$offset)
    if ($length -lt 1 -or $offset + $length -gt $sequenceEnd) { throw 'The SAN entry is malformed.' }
    [byte[]]$payload = $raw[$offset..($offset + $length - 1)]
    $offset += $length
    if ($tag -eq 0x82) {
      $names += [Text.Encoding]::ASCII.GetString($payload).TrimEnd('.').ToLowerInvariant()
    }
    elseif ($tag -eq 0x87) {
      if ($length -ne 4 -and $length -ne 16) { throw 'The SAN IP address is malformed.' }
      $names += ([Net.IPAddress]::new($payload)).ToString().ToLowerInvariant()
    }
    else {
      throw 'The SAN extension contains an unsupported Local Live name type.'
    }
  }
  return @($names | Sort-Object -Unique)
}
$leafThumbprint = Normalize-Thumbprint $inputData.certificateThumbprint
$rootThumbprint = Normalize-Thumbprint $inputData.rootThumbprint
$root = Get-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $rootThumbprint) -ErrorAction SilentlyContinue
$leaf = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $leafThumbprint) -ErrorAction SilentlyContinue
$rootSigner = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $rootThumbprint) -ErrorAction SilentlyContinue
$pfx = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
  [string]$inputData.pfxPath,
  [string]$inputData.pfxPassword,
  [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
)
$rootFile = [Security.Cryptography.X509Certificates.X509Certificate2]::new([string]$inputData.rootCertificatePath)
$actualSans = @(Read-SubjectAlternativeNames $pfx)
$expectedSans = @($inputData.requiredSans | ForEach-Object { ([string]$_).TrimEnd('.').ToLowerInvariant() } | Sort-Object -Unique)
$sansMatch = $actualSans.Count -eq $expectedSans.Count -and
  @($expectedSans | Where-Object { $_ -notin $actualSans }).Count -eq 0
$serverAuthOid = '1.3.6.1.5.5.7.3.1'
$ekuExtensions = @($pfx.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
$enhancedKeyUsages = if ($ekuExtensions.Count -eq 1) {
  @($ekuExtensions[0].EnhancedKeyUsages | ForEach-Object { [string]$_.Value } | Sort-Object -Unique)
} else { @() }
$serverAuthPurpose = $ekuExtensions.Count -eq 1 -and $enhancedKeyUsages -contains $serverAuthOid
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
$chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
$chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(2)
$chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new($serverAuthOid)) | Out-Null
$chainBuilt = $chain.Build($pfx)
$chainRootThumbprint = if ($chain.ChainElements.Count -gt 0) {
  Normalize-Thumbprint $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint
} else { '' }
$chainStatus = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
$now = [DateTimeOffset]::Parse([string]$inputData.now).UtcDateTime
[ordered]@{
  rootTrusted = ($null -ne $root)
  leafPresent = ($null -ne $leaf)
  leafHasPrivateKey = ($null -ne $leaf -and $leaf.HasPrivateKey)
  rootSignerPresent = ($null -ne $rootSigner)
  rootSignerHasPrivateKey = ($null -ne $rootSigner -and $rootSigner.HasPrivateKey)
  pfxHasPrivateKey = $pfx.HasPrivateKey
  rootFileHasPrivateKey = $rootFile.HasPrivateKey
  pfxLeafThumbprint = Normalize-Thumbprint $pfx.Thumbprint
  storeLeafThumbprint = if ($null -ne $leaf) { Normalize-Thumbprint $leaf.Thumbprint } else { $null }
  storeRootThumbprint = if ($null -ne $root) { Normalize-Thumbprint $root.Thumbprint } else { $null }
  storeRootSignerThumbprint = if ($null -ne $rootSigner) { Normalize-Thumbprint $rootSigner.Thumbprint } else { $null }
  rootFileThumbprint = Normalize-Thumbprint $rootFile.Thumbprint
  subject = $pfx.Subject
  issuer = $pfx.Issuer
  sans = $actualSans
  sansMatch = [bool]$sansMatch
  hostnameMatch = $actualSans -contains ([string]$inputData.hostname).ToLowerInvariant()
  enhancedKeyUsages = $enhancedKeyUsages
  serverAuthPurpose = [bool]$serverAuthPurpose
  leafCurrentlyValid = ($pfx.NotBefore.ToUniversalTime() -le $now -and $pfx.NotAfter.ToUniversalTime() -gt $now)
  rootCurrentlyValid = ($rootFile.NotBefore.ToUniversalTime() -le $now -and $rootFile.NotAfter.ToUniversalTime() -gt $now)
  notBefore = $pfx.NotBefore.ToUniversalTime().ToString('o')
  notAfter = $pfx.NotAfter.ToUniversalTime().ToString('o')
  rootNotAfter = $rootFile.NotAfter.ToUniversalTime().ToString('o')
  chainBuilt = [bool]$chainBuilt
  chainRootThumbprint = $chainRootThumbprint
  chainStatus = $chainStatus
} | ConvertTo-Json -Depth 5 -Compress | Write-Output
`;

function runPowerShell(script, input, options = {}) {
  const result = spawnSync(
    options.powershellExecutable ?? "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      input,
      maxBuffer: 262_144,
      shell: false,
      windowsHide: true,
    },
  );
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? "").trim(),
  };
}

function powerShellInvocationOptions(options) {
  return options.powershellExecutable === undefined
    ? {}
    : { powershellExecutable: options.powershellExecutable };
}

export function createCertificateSetupPlan(options = {}) {
  const paths = options.paths ?? productionPaths;
  const hostname = (options.hostname ?? "bea.localhost").trim().toLowerCase();
  if (!isLoopbackSafeHostname(hostname)) {
    throw new Error("Local Live certificate hostname must be loopback-safe.");
  }
  const validityDays = options.validityDays ?? 397;
  if (!Number.isSafeInteger(validityDays) || validityDays < 30 || validityDays > 825) {
    throw new Error("Certificate validity must be from 30 through 825 days.");
  }
  assertPathContained(paths.productRoot, paths.certificateDirectory, "Certificate directory");
  return Object.freeze({
    hostname,
    validityDays,
    sans: Object.freeze([hostname, "localhost", "127.0.0.1", "::1"]),
    pfxPath: paths.certificatePfxFile,
    rootCertificatePath: paths.certificateRootFile,
    trustStore: "Cert:\\CurrentUser\\Root",
    privateKeyStore: "Cert:\\CurrentUser\\My",
  });
}

export function validateCertificateMetadata(value, options = {}) {
  const issues = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Certificate metadata is invalid.");
  }
  const unknown = Object.keys(value).filter((key) => !certificateMetadataKeys.includes(key));
  if (unknown.length > 0) issues.push(`unknown fields: ${unknown.join(", ")}`);
  const hostname = String(value.hostname ?? "")
    .trim()
    .toLowerCase();
  if (value.schemaVersion !== CERTIFICATE_METADATA_VERSION)
    issues.push("unsupported schema version");
  if (!isLoopbackSafeHostname(hostname)) issues.push("hostname is not loopback-safe");
  if (value.subject !== `CN=${hostname}`) issues.push("subject is invalid");
  if (value.issuer !== "CN=BEA Local Production Root") issues.push("issuer is invalid");
  if (!/^[A-Fa-f0-9]{40,128}$/u.test(value.certificateThumbprint ?? "")) {
    issues.push("leaf thumbprint is invalid");
  }
  if (!/^[A-Fa-f0-9]{40,128}$/u.test(value.rootThumbprint ?? "")) {
    issues.push("root thumbprint is invalid");
  }
  const sans = Array.isArray(value.sans) ? value.sans.map(String) : [];
  const requiredSans = [hostname, "localhost", "127.0.0.1", "::1"];
  for (const required of requiredSans) {
    if (!sans.includes(required)) issues.push(`SAN ${required} is missing`);
  }
  if (sans.length !== requiredSans.length || new Set(sans).size !== requiredSans.length) {
    issues.push("SAN list must contain only the required Local Live names");
  }
  const notBefore = Date.parse(value.notBefore);
  const now = (options.now ?? new Date()).getTime();
  const notAfter = Date.parse(value.notAfter);
  if (!Number.isFinite(notBefore)) issues.push("certificate notBefore is invalid");
  if (!Number.isFinite(notAfter) || notAfter <= now) issues.push("certificate is expired");
  if (Number.isFinite(notBefore) && Number.isFinite(notAfter) && notAfter <= notBefore) {
    issues.push("certificate validity window is invalid");
  }
  const pfxPath = resolve(value.pfxPath ?? "");
  const rootCertificatePath = resolve(value.rootCertificatePath ?? "");
  const expectedRoot = options.productRoot ?? productionPaths.productRoot;
  try {
    assertPathContained(expectedRoot, pfxPath, "Certificate PFX path");
  } catch (error) {
    issues.push(error.message);
  }
  try {
    assertPathContained(expectedRoot, rootCertificatePath, "Root certificate path");
  } catch (error) {
    issues.push(error.message);
  }
  if (value.trustStore !== "Cert:\\CurrentUser\\Root") {
    issues.push("trustStore must be CurrentUser Root");
  }
  if (value.privateKeyStore !== "Cert:\\CurrentUser\\My") {
    issues.push("privateKeyStore must be CurrentUser My");
  }
  if (issues.length > 0) throw new Error(`Certificate metadata is invalid: ${issues.join("; ")}`);
  return Object.freeze({
    schemaVersion: CERTIFICATE_METADATA_VERSION,
    hostname,
    subject: value.subject,
    issuer: value.issuer,
    certificateThumbprint: value.certificateThumbprint.toUpperCase(),
    rootThumbprint: value.rootThumbprint.toUpperCase(),
    sans: Object.freeze(sans),
    notBefore: new Date(notBefore).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
    trustStore: value.trustStore,
    privateKeyStore: value.privateKeyStore,
    pfxPath,
    rootCertificatePath,
    daysUntilExpiration: Math.floor((notAfter - now) / 86_400_000),
    renewalWarning: notAfter - now <= (options.warningDays ?? 45) * 86_400_000,
  });
}

function persistentCertificateMetadata(metadata) {
  return Object.fromEntries(certificateMetadataKeys.map((key) => [key, metadata[key]]));
}

export async function setupTrustedLocalCertificate(options = {}) {
  if (typeof options.pfxPassword !== "string" || options.pfxPassword.length < 32) {
    throw new Error("A strong protected PFX password is required.");
  }
  const plan = createCertificateSetupPlan(options);
  if (typeof options.confirmTrust !== "function") {
    throw new Error(
      "Explicit Owner confirmation is required before trusting a local certificate root.",
    );
  }
  const confirmed = await options.confirmTrust({
    action: "trust-local-certificate-root",
    subject: "CN=BEA Local Production Root",
    trustStore: plan.trustStore,
    hostname: plan.hostname,
    sans: plan.sans,
    machineWide: false,
  });
  if (confirmed !== true) throw new Error("Owner declined local certificate trust.");

  mkdirSync(resolve(options.paths?.certificateDirectory ?? productionPaths.certificateDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const input = JSON.stringify({
    hostname: plan.hostname,
    validityDays: plan.validityDays,
    pfxPath: plan.pfxPath,
    rootCertificatePath: plan.rootCertificatePath,
    pfxPassword: options.pfxPassword,
  });
  const result = await (options.executePowerShell ?? runPowerShell)(
    setupScript,
    input,
    powerShellInvocationOptions(options),
  );
  if (result.exitCode !== 0) throw new Error("Local certificate setup failed closed.");
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new Error("Local certificate setup returned invalid metadata.");
  }
  const validated = validateCertificateMetadata(metadata, {
    productRoot: options.paths?.productRoot ?? productionPaths.productRoot,
    now: options.now,
  });
  const inspection = await (options.inspectTrust ?? inspectCertificateTrust)(validated, {
    productRoot: options.paths?.productRoot ?? productionPaths.productRoot,
    now: options.now,
    pfxPassword: options.pfxPassword,
    executePowerShell: options.executePowerShell,
    metadataValidated: true,
  });
  if (!inspection.contractValid) {
    throw new Error("Local certificate artifacts or CurrentUser trust failed validation.");
  }
  writeFileSync(
    options.paths?.certificateMetadataFile ?? productionPaths.certificateMetadataFile,
    `${JSON.stringify(persistentCertificateMetadata(validated), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await options.applyAcl?.(
    options.paths?.certificateDirectory ?? productionPaths.certificateDirectory,
  );
  return validated;
}

export async function inspectCertificateTrust(metadata, options = {}) {
  const validated =
    options.metadataValidated === true ? metadata : validateCertificateMetadata(metadata, options);
  if (typeof options.pfxPassword !== "string" || options.pfxPassword.length < 32) {
    throw new Error("The protected PFX password is required for certificate inspection.");
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("Certificate inspection time is invalid.");
  const result = await (options.executePowerShell ?? runPowerShell)(
    trustInspectionScript,
    JSON.stringify({
      certificateThumbprint: validated.certificateThumbprint,
      hostname: validated.hostname,
      now: now.toISOString(),
      pfxPassword: options.pfxPassword,
      pfxPath: validated.pfxPath,
      requiredSans: [validated.hostname, "localhost", "127.0.0.1", "::1"],
      rootCertificatePath: validated.rootCertificatePath,
      rootThumbprint: validated.rootThumbprint,
    }),
    powerShellInvocationOptions(options),
  );
  if (result.exitCode !== 0) throw new Error("Certificate trust inspection failed.");
  let inspection;
  try {
    inspection = JSON.parse(result.stdout);
  } catch {
    throw new Error("Certificate trust inspection returned invalid data.");
  }
  if (typeof inspection !== "object" || inspection === null || Array.isArray(inspection)) {
    throw new Error("Certificate trust inspection returned invalid data.");
  }
  const expectedSans = [validated.hostname, "localhost", "127.0.0.1", "::1"].sort();
  const actualSans = Array.isArray(inspection.sans)
    ? [...new Set(inspection.sans.map((value) => String(value).toLowerCase()))].sort()
    : [];
  const enhancedKeyUsages = Array.isArray(inspection.enhancedKeyUsages)
    ? [...new Set(inspection.enhancedKeyUsages.map(String))].sort()
    : [];
  const serverAuthPurpose =
    inspection.serverAuthPurpose === true && enhancedKeyUsages.includes("1.3.6.1.5.5.7.3.1");
  const actualNotAfter = Date.parse(inspection.notAfter);
  const actualNotBefore = Date.parse(inspection.notBefore);
  const metadataNotAfter = Date.parse(validated.notAfter);
  const metadataNotBefore = Date.parse(validated.notBefore);
  const validityMatchesMetadata =
    Number.isFinite(actualNotAfter) &&
    Number.isFinite(metadataNotAfter) &&
    Math.abs(actualNotAfter - metadataNotAfter) < 1_000 &&
    Number.isFinite(actualNotBefore) &&
    Number.isFinite(metadataNotBefore) &&
    Math.abs(actualNotBefore - metadataNotBefore) < 1_000;
  const thumbprintsMatch =
    inspection.pfxLeafThumbprint === validated.certificateThumbprint &&
    inspection.storeLeafThumbprint === validated.certificateThumbprint &&
    inspection.storeRootThumbprint === validated.rootThumbprint &&
    inspection.storeRootSignerThumbprint === validated.rootThumbprint &&
    inspection.rootFileThumbprint === validated.rootThumbprint &&
    inspection.chainRootThumbprint === validated.rootThumbprint;
  const identityMatches =
    inspection.subject === validated.subject &&
    inspection.issuer === validated.issuer &&
    inspection.hostnameMatch === true &&
    inspection.sansMatch === true &&
    serverAuthPurpose &&
    actualSans.length === expectedSans.length &&
    actualSans.every((value, index) => value === expectedSans[index]) &&
    validityMatchesMetadata;
  const privateKeysReady =
    inspection.leafHasPrivateKey === true &&
    inspection.rootSignerPresent === true &&
    inspection.pfxHasPrivateKey === true &&
    inspection.rootSignerHasPrivateKey === true &&
    inspection.rootFileHasPrivateKey === false;
  const chainStatuses = Array.isArray(inspection.chainStatus)
    ? inspection.chainStatus.map(String)
    : null;
  const chainValid =
    inspection.chainBuilt === true &&
    chainStatuses !== null &&
    chainStatuses.every((status) => status === "NoError");
  const artifactsPresent =
    existsSync(validated.pfxPath) && existsSync(validated.rootCertificatePath);
  const trusted =
    inspection.rootTrusted === true &&
    inspection.leafPresent === true &&
    thumbprintsMatch &&
    identityMatches &&
    privateKeysReady &&
    chainValid &&
    inspection.leafCurrentlyValid === true &&
    inspection.rootCurrentlyValid === true &&
    artifactsPresent;
  return Object.freeze({
    trusted,
    contractValid: trusted,
    artifactsPresent,
    rootTrusted: inspection.rootTrusted === true,
    leafPresent: inspection.leafPresent === true,
    leafHasPrivateKey: inspection.leafHasPrivateKey === true,
    rootSignerPresent: inspection.rootSignerPresent === true,
    rootSignerHasPrivateKey: inspection.rootSignerHasPrivateKey === true,
    pfxPresent: existsSync(validated.pfxPath),
    pfxHasPrivateKey: inspection.pfxHasPrivateKey === true,
    rootCertificatePresent: existsSync(validated.rootCertificatePath),
    rootFileHasPrivateKey: inspection.rootFileHasPrivateKey === true,
    privateKeysReady,
    thumbprintsMatch,
    identityMatches,
    validityMatchesMetadata,
    chainValid,
    chainStatus: Object.freeze(chainStatuses ?? []),
    subject: typeof inspection.subject === "string" ? inspection.subject : null,
    issuer: typeof inspection.issuer === "string" ? inspection.issuer : null,
    hostnameMatch: inspection.hostnameMatch === true,
    sansMatch: inspection.sansMatch === true,
    enhancedKeyUsages: Object.freeze(enhancedKeyUsages),
    serverAuthPurpose,
    leafCurrentlyValid: inspection.leafCurrentlyValid === true,
    rootCurrentlyValid: inspection.rootCurrentlyValid === true,
    pfxLeafThumbprint: inspection.pfxLeafThumbprint ?? null,
    storeLeafThumbprint: inspection.storeLeafThumbprint ?? null,
    storeRootThumbprint: inspection.storeRootThumbprint ?? null,
    storeRootSignerThumbprint: inspection.storeRootSignerThumbprint ?? null,
    rootFileThumbprint: inspection.rootFileThumbprint ?? null,
    chainRootThumbprint: inspection.chainRootThumbprint ?? null,
    sans: Object.freeze(actualSans),
    notBefore: inspection.notBefore ?? null,
    notAfter: Number.isFinite(actualNotAfter) ? new Date(actualNotAfter).toISOString() : null,
    rootNotAfter: inspection.rootNotAfter ?? null,
    daysUntilExpiration: Number.isFinite(actualNotAfter)
      ? Math.floor((actualNotAfter - now.getTime()) / 86_400_000)
      : Number.NEGATIVE_INFINITY,
    renewalWarning:
      !Number.isFinite(actualNotAfter) ||
      actualNotAfter - now.getTime() <= (options.warningDays ?? 45) * 86_400_000,
  });
}
