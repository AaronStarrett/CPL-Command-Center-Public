const credentialPatterns = [
  /\b(?:password|secret|token|authorization|cookie|credential|api[-_ ]?key)\b\s*[:=]\s*\S{4,}/iu,
  /\bbearer\s+[a-z\d._~+/-]{8,}=*/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bsk-[a-z\d_-]{12,}\b/iu,
  /\b(?:sk|pk)_(?:live|test)_[a-z\d]{12,}\b/iu,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu,
] as const;

export function containsCredentialLikeContent(value: string): boolean {
  return credentialPatterns.some((pattern) => pattern.test(value));
}

export class SensitiveContentRejectedError extends Error {
  readonly code = "SENSITIVE_CONTENT_REJECTED";

  constructor() {
    super(
      "Credential-like content cannot be stored in AI Command. Remove passwords, tokens, keys, or credential-bearing URLs and try again.",
    );
    this.name = "SensitiveContentRejectedError";
  }
}

export function requireCredentialSafeContent(value: string): void {
  if (containsCredentialLikeContent(value)) throw new SensitiveContentRejectedError();
}
