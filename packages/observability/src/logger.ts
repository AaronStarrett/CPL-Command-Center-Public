import { randomUUID } from "node:crypto";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type LogBindings = Readonly<Record<string, unknown>>;

export interface StructuredLogger {
  child(bindings: LogBindings): StructuredLogger;
  trace(bindings: LogBindings, message: string): void;
  debug(bindings: LogBindings, message: string): void;
  info(bindings: LogBindings, message: string): void;
  warn(bindings: LogBindings, message: string): void;
  error(bindings: LogBindings, message: string): void;
  fatal(bindings: LogBindings, message: string): void;
}

export const REDACTED_VALUE = "[REDACTED]";

export const PINO_REDACTION_PATHS = [
  "password",
  "secret",
  "token",
  "sessionToken",
  "session.token",
  "session.tokenHash",
  "apiKey",
  "authorization",
  "cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "*.password",
  "*.secret",
  "*.token",
  "*.sessionToken",
  "*.apiKey",
  "*.authorization",
  "*.cookie",
] as const;

const sensitiveKey = /(?:password|secret|token|authorization|cookie|credential|api[-_]?key)/iu;

const PROCESS_LOGGER_REGISTRY = Symbol.for("@bea/observability/process-logger-registry/v1");

// Next.js can evaluate server modules more than once while recompiling routes. Keeping
// immutable root loggers on globalThis prevents each evaluation from creating another
// Pino destination (and another process-exit hook). Child bindings remain per call.
function processLoggerRegistry(): Map<string, StructuredLogger> {
  const existing = Reflect.get(globalThis, PROCESS_LOGGER_REGISTRY) as unknown;
  if (existing instanceof Map) {
    return existing as Map<string, StructuredLogger>;
  }

  const registry = new Map<string, StructuredLogger>();
  Reflect.set(globalThis, PROCESS_LOGGER_REGISTRY, registry);
  return registry;
}

export function redactSensitive(input: unknown): unknown {
  const visited = new WeakSet<object>();

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (visited.has(value)) {
        return "[CIRCULAR]";
      }
      visited.add(value);
      return value.map(visit);
    }
    if (value && typeof value === "object") {
      if (visited.has(value)) {
        return "[CIRCULAR]";
      }
      visited.add(value);
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          sensitiveKey.test(key) ? REDACTED_VALUE : visit(nested),
        ]),
      );
    }
    return value;
  };

  return visit(input);
}

function sanitizedBindings(bindings: LogBindings): Record<string, unknown> {
  return redactSensitive(bindings) as Record<string, unknown>;
}

function wrapLogger(logger: Logger): StructuredLogger {
  return {
    child: (bindings) => wrapLogger(logger.child(sanitizedBindings(bindings))),
    trace: (bindings, message) => logger.trace(sanitizedBindings(bindings), message),
    debug: (bindings, message) => logger.debug(sanitizedBindings(bindings), message),
    info: (bindings, message) => logger.info(sanitizedBindings(bindings), message),
    warn: (bindings, message) => logger.warn(sanitizedBindings(bindings), message),
    error: (bindings, message) => logger.error(sanitizedBindings(bindings), message),
    fatal: (bindings, message) => logger.fatal(sanitizedBindings(bindings), message),
  };
}

export function createLogger(input: {
  service: string;
  environment: string;
  level?: LoggerOptions["level"];
  destination?: DestinationStream;
}): StructuredLogger {
  const level = input.level ?? "info";
  // Custom destinations are intentionally never shared: callers own their stream lifetime.
  const registry = input.destination === undefined ? processLoggerRegistry() : undefined;
  const registryKey = registry
    ? JSON.stringify([input.service, input.environment, level])
    : undefined;
  const existing = registryKey ? registry?.get(registryKey) : undefined;
  if (existing) {
    return existing;
  }

  const logger = pino(
    {
      name: input.service,
      level,
      base: { service: input.service, environment: input.environment },
      redact: { paths: [...PINO_REDACTION_PATHS], censor: REDACTED_VALUE },
    },
    input.destination,
  );
  const structuredLogger = wrapLogger(logger);
  if (registry && registryKey) {
    registry.set(registryKey, structuredLogger);
  }
  return structuredLogger;
}

export function createCorrelationId(): string {
  return randomUUID();
}
