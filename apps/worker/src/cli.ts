export interface WorkerCliOptions {
  readonly mode: "once" | "serve";
  readonly idempotencyKey: string;
}

export function parseWorkerArguments(
  arguments_: readonly string[],
  defaultMode: "once" | "serve" = "once",
): WorkerCliOptions {
  const hasOnce = arguments_.includes("--once");
  const hasServe = arguments_.includes("--serve");
  if (hasOnce && hasServe) throw new Error("Choose either --once or --serve, not both.");
  const keyArgument = arguments_.find((argument) => argument.startsWith("--idempotency-key="));
  const idempotencyKey =
    keyArgument?.slice("--idempotency-key=".length) ?? "manual:foundation.system-health-check:v1";
  if (!idempotencyKey.trim()) throw new Error("--idempotency-key must not be empty.");
  return { mode: hasServe ? "serve" : hasOnce ? "once" : defaultMode, idempotencyKey };
}
