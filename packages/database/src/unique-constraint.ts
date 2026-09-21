export function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  if (code === "23505") return true;
  const message = error instanceof Error ? error.message : String(record.message ?? "");
  if (/duplicate key|unique constraint|unique_violation/iu.test(message)) return true;
  if (record.cause && record.cause !== error) {
    return isUniqueConstraintViolation(record.cause);
  }
  return false;
}
