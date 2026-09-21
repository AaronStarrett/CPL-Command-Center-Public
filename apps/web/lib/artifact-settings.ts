import { MAXIMUM_ARTIFACT_UPLOAD_BYTES, MAXIMUM_GENERATED_ARTIFACT_BYTES } from "@bea/artifacts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export function effectiveArtifactUploadBytes(configuredBytes: number): number {
  return boundedInteger(configuredBytes, 1_024, MAXIMUM_ARTIFACT_UPLOAD_BYTES);
}

export function effectiveGeneratedArtifactBytes(configuredBytes: number): number {
  return boundedInteger(configuredBytes, 1_024, MAXIMUM_GENERATED_ARTIFACT_BYTES);
}

export function effectiveArtifactRetentionMilliseconds(configuredDays: number): number {
  return boundedInteger(configuredDays, 1, 90) * DAY_MILLISECONDS;
}

export function effectiveArtifactUploadRateLimit(configuredPerMinute: number): number {
  return boundedInteger(configuredPerMinute, 1, 12);
}
