import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookVerificationResult {
  readonly valid: boolean;
  readonly reason?: "missing-signature" | "malformed-signature" | "signature-mismatch";
}

export function verifyHmacSha256Webhook(input: {
  rawBody: Uint8Array;
  signatureHeader: string | undefined;
  secret: string;
}): WebhookVerificationResult {
  if (!input.signatureHeader) {
    return { valid: false, reason: "missing-signature" };
  }
  const suppliedHex = input.signatureHeader.startsWith("sha256=")
    ? input.signatureHeader.slice("sha256=".length)
    : input.signatureHeader;
  if (!/^[a-f\d]{64}$/iu.test(suppliedHex)) {
    return { valid: false, reason: "malformed-signature" };
  }
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return timingSafeEqual(expected, supplied)
    ? { valid: true }
    : { valid: false, reason: "signature-mismatch" };
}

export interface WebhookReceiptStore {
  claim(provider: string, externalEventId: string): Promise<boolean>;
}
