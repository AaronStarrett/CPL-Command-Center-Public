import { loadRepositoryEnvironment, type ServerEnvironment } from "@bea/config";

type LoggingEnvironment = Pick<ServerEnvironment, "nodeEnv" | "logLevel">;
type LoggingEnvironmentLoader = () => { readonly environment: LoggingEnvironment };

export interface WebLoggingConfiguration {
  readonly environment: ServerEnvironment["nodeEnv"] | "unknown";
  readonly level: ServerEnvironment["logLevel"];
  readonly usedSafeFallback: boolean;
}

export function resolveWebLoggingConfiguration(
  loadEnvironment: LoggingEnvironmentLoader = loadRepositoryEnvironment,
): WebLoggingConfiguration {
  try {
    const { environment } = loadEnvironment();
    return {
      environment: environment.nodeEnv,
      level: environment.logLevel,
      usedSafeFallback: false,
    };
  } catch {
    return { environment: "unknown", level: "info", usedSafeFallback: true };
  }
}
