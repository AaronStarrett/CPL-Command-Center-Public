import { z } from "zod";

import { isLoopbackHostname, parseExactHttpOrigin } from "./trusted-origins.js";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

const optionalFromBlank = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

const appBaseUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const isHttpOrigin = url.protocol === "http:" || url.protocol === "https:";
    const hasOnlyOriginPath = url.pathname === "/";
    const hasQueryOrFragment =
      url.search.length > 0 || url.hash.length > 0 || value.includes("?") || value.includes("#");
    if (
      !isHttpOrigin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !hasOnlyOriginPath ||
      hasQueryOrFragment
    ) {
      context.addIssue({
        code: "custom",
        message:
          "APP_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
      });
    }
  });

const rawEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    BEA_RUNTIME_MODE: optionalFromBlank(z.enum(["development", "production"])),
    APP_MODE: z.enum(["demo", "production"]).default("production"),
    BEA_DEPLOYMENT_PROFILE: optionalFromBlank(
      z.enum(["demo", "owner-evaluation", "local-live", "enterprise"]),
    ),
    BEA_AUTH_PROVIDER: optionalFromBlank(z.enum(["demo", "local-owner", "microsoft-entra"])),
    APP_BASE_URL: appBaseUrlSchema.default("http://localhost:3000"),
    BEA_OWNER_EVALUATION_PUBLIC_ORIGIN: optionalFromBlank(z.string().url()),
    DATABASE_DRIVER: optionalFromBlank(z.enum(["postgres", "pglite"])),
    DATABASE_URL: optionalFromBlank(z.string().min(1)),
    DEMO_DATABASE_PATH: z.string().min(1).default("memory://"),
    WORKER_DEMO_DATABASE_PATH: z.string().min(1).default("memory://"),
    DEMO_AUTH_ENABLED: optionalFromBlank(booleanString),
    SESSION_SECRET: optionalFromBlank(z.string().min(32)),
    SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(480),
    WORKER_MODE: optionalFromBlank(z.enum(["once", "serve"])),
    WORKER_QUEUE_ADAPTER: optionalFromBlank(z.enum(["inline", "pg-boss"])),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
  })
  .superRefine((environment, context) => {
    const runtimeMode =
      environment.NODE_ENV === "production"
        ? "production"
        : environment.NODE_ENV === "test"
          ? "test"
          : (environment.BEA_RUNTIME_MODE ??
            (environment.APP_MODE === "production" ? "production" : "development"));
    const databaseDriver =
      environment.DATABASE_DRIVER ?? (environment.APP_MODE === "demo" ? "pglite" : "postgres");
    const demoAuthEnabled = environment.DEMO_AUTH_ENABLED ?? environment.APP_MODE === "demo";
    const deploymentProfile =
      environment.BEA_DEPLOYMENT_PROFILE ??
      (environment.APP_MODE === "demo" ? "demo" : "enterprise");
    const authProvider =
      environment.BEA_AUTH_PROVIDER ??
      (deploymentProfile === "demo" || deploymentProfile === "owner-evaluation"
        ? "demo"
        : deploymentProfile === "local-live"
          ? "local-owner"
          : "microsoft-entra");
    const queueAdapter =
      environment.WORKER_QUEUE_ADAPTER ?? (environment.APP_MODE === "demo" ? "inline" : "pg-boss");
    const workerMode =
      environment.WORKER_MODE ?? (environment.APP_MODE === "demo" ? "once" : "serve");

    // Synthetic identities and providers are retained only for an explicit automated-test harness.
    // A development server and an optimized Next build are both real application entry points.
    if (
      environment.NODE_ENV !== "test" &&
      (environment.APP_MODE === "demo" ||
        demoAuthEnabled ||
        authProvider === "demo" ||
        deploymentProfile === "owner-evaluation")
    ) {
      context.addIssue({
        code: "custom",
        path: ["APP_MODE"],
        message: "Synthetic runtimes require an isolated NODE_ENV=test harness",
      });
    }
    if (environment.NODE_ENV === "production" && environment.BEA_RUNTIME_MODE === "development") {
      context.addIssue({
        code: "custom",
        path: ["BEA_RUNTIME_MODE"],
        message: "NODE_ENV=production cannot be weakened by BEA_RUNTIME_MODE=development",
      });
    }
    if (runtimeMode === "production" && environment.APP_MODE !== "production") {
      context.addIssue({
        code: "custom",
        path: ["APP_MODE"],
        message: "BEA production runtime requires APP_MODE=production",
      });
    }
    if (runtimeMode === "development" && environment.APP_MODE === "production") {
      context.addIssue({
        code: "custom",
        path: ["BEA_RUNTIME_MODE"],
        message: "APP_MODE=production cannot run with BEA_RUNTIME_MODE=development",
      });
    }

    if (
      deploymentProfile === "demo" &&
      (environment.APP_MODE !== "demo" || authProvider !== "demo")
    ) {
      context.addIssue({
        code: "custom",
        path: ["BEA_DEPLOYMENT_PROFILE"],
        message: "The demo deployment profile requires APP_MODE=demo and BEA_AUTH_PROVIDER=demo",
      });
    }
    if (deploymentProfile === "owner-evaluation") {
      const url = new URL(environment.APP_BASE_URL);
      const hostname = url.hostname.toLowerCase();
      const loopbackHostname = isLoopbackHostname(hostname);
      let publicOrigin: string | undefined;
      if (environment.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN) {
        try {
          publicOrigin = parseExactHttpOrigin(
            environment.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN,
            "BEA_OWNER_EVALUATION_PUBLIC_ORIGIN",
          );
        } catch {
          context.addIssue({
            code: "custom",
            path: ["BEA_OWNER_EVALUATION_PUBLIC_ORIGIN"],
            message:
              "BEA_OWNER_EVALUATION_PUBLIC_ORIGIN must be an exact HTTP(S) origin without wildcards",
          });
        }
      }
      const publicOriginMatchesApp =
        publicOrigin !== undefined && publicOrigin === new URL(environment.APP_BASE_URL).origin;
      if (
        environment.APP_MODE !== "demo" ||
        authProvider !== "demo" ||
        (!loopbackHostname && !publicOriginMatchesApp)
      ) {
        context.addIssue({
          code: "custom",
          path: ["BEA_DEPLOYMENT_PROFILE"],
          message:
            "Owner Evaluation requires APP_MODE=demo, demo authentication, and a loopback origin or an exact public origin allowlist",
        });
      }
      if (databaseDriver !== "pglite") {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_DRIVER"],
          message: "Owner Evaluation uses PGlite for isolated synthetic BEA records only",
        });
      }
    }
    if (deploymentProfile === "local-live") {
      const url = new URL(environment.APP_BASE_URL);
      const hostname = url.hostname.toLowerCase();
      const loopbackHostname =
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]";
      if (
        environment.APP_MODE !== "production" ||
        authProvider !== "local-owner" ||
        url.protocol !== "https:" ||
        !loopbackHostname
      ) {
        context.addIssue({
          code: "custom",
          path: ["BEA_DEPLOYMENT_PROFILE"],
          message:
            "Local Live requires production mode, local-owner authentication, HTTPS, and a loopback .localhost origin",
        });
      }
      if (!environment.SESSION_SECRET || environment.SESSION_SECRET.length < 64) {
        context.addIssue({
          code: "custom",
          path: ["SESSION_SECRET"],
          message: "Local Live requires a session secret with at least 64 characters",
        });
      }
    }
    if (deploymentProfile === "enterprise" && authProvider !== "microsoft-entra") {
      context.addIssue({
        code: "custom",
        path: ["BEA_AUTH_PROVIDER"],
        message: "Enterprise deployments require Microsoft Entra authentication",
      });
    }
    if (authProvider === "local-owner" && deploymentProfile !== "local-live") {
      context.addIssue({
        code: "custom",
        path: ["BEA_AUTH_PROVIDER"],
        message: "Local Owner authentication is restricted to the Local Live deployment profile",
      });
    }

    if (runtimeMode === "production") {
      if (new URL(environment.APP_BASE_URL).protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["APP_BASE_URL"],
          message: "Production mode requires an HTTPS APP_BASE_URL",
        });
      }
      if (demoAuthEnabled) {
        context.addIssue({
          code: "custom",
          path: ["DEMO_AUTH_ENABLED"],
          message: "Demo authentication must be disabled in production mode",
        });
      }
      if (databaseDriver !== "postgres") {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_DRIVER"],
          message: "Production mode requires the PostgreSQL database driver",
        });
      }
      if (!environment.DATABASE_URL?.match(/^postgres(?:ql)?:\/\//u)) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "Production mode requires a PostgreSQL DATABASE_URL",
        });
      }
      if (!environment.SESSION_SECRET) {
        context.addIssue({
          code: "custom",
          path: ["SESSION_SECRET"],
          message: "Production mode requires SESSION_SECRET with at least 32 characters",
        });
      }
      if (queueAdapter !== "pg-boss") {
        context.addIssue({
          code: "custom",
          path: ["WORKER_QUEUE_ADAPTER"],
          message: "Production mode requires the pg-boss queue adapter",
        });
      }
      if (workerMode !== "serve") {
        context.addIssue({
          code: "custom",
          path: ["WORKER_MODE"],
          message: "Production mode requires WORKER_MODE=serve",
        });
      }
      if (environment.WORKER_HEALTH_PORT === 0) {
        context.addIssue({
          code: "custom",
          path: ["WORKER_HEALTH_PORT"],
          message: "Production mode requires a fixed non-zero worker health port",
        });
      }
    }
  });

export interface ServerEnvironment {
  readonly nodeEnv: "development" | "test" | "production";
  readonly runtimeMode: "development" | "production" | "test";
  readonly appMode: "demo" | "production";
  readonly deploymentProfile: "demo" | "owner-evaluation" | "local-live" | "enterprise";
  readonly authProvider: "demo" | "local-owner" | "microsoft-entra";
  readonly appBaseUrl: string;
  readonly ownerEvaluationPublicOrigin?: string;
  readonly secureCookies: boolean;
  readonly databaseDriver: "postgres" | "pglite";
  readonly databaseUrl?: string;
  readonly demoDatabasePath: string;
  readonly workerDemoDatabasePath: string;
  readonly demoAuthEnabled: boolean;
  readonly sessionSecret?: string;
  readonly sessionTtlMinutes: number;
  readonly workerMode: "once" | "serve";
  readonly workerQueueAdapter: "inline" | "pg-boss";
  readonly workerPollIntervalMs: number;
  readonly workerHealthPort: number;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
}

export interface PublicEnvironment {
  readonly runtimeMode: "development" | "production" | "test";
  readonly appMode: "demo" | "production";
  readonly productionMode: boolean;
  readonly demoMode: boolean;
  readonly ownerEvaluation: boolean;
  readonly nodeEnv: "development" | "test" | "production";
}

export interface EnvironmentIssue {
  readonly path: string;
  readonly message: string;
}

export class EnvironmentValidationError extends Error {
  readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[]) {
    super(
      `Environment validation failed: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

export function parseEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): ServerEnvironment {
  const result = rawEnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new EnvironmentValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "environment",
        message: issue.message,
      })),
    );
  }

  const raw = result.data;
  const runtimeMode =
    raw.NODE_ENV === "production"
      ? "production"
      : raw.NODE_ENV === "test"
        ? "test"
        : (raw.BEA_RUNTIME_MODE ?? (raw.APP_MODE === "production" ? "production" : "development"));
  const databaseDriver = raw.DATABASE_DRIVER ?? (raw.APP_MODE === "demo" ? "pglite" : "postgres");
  const workerQueueAdapter =
    raw.WORKER_QUEUE_ADAPTER ?? (raw.APP_MODE === "demo" ? "inline" : "pg-boss");
  const workerMode = raw.WORKER_MODE ?? (raw.APP_MODE === "demo" ? "once" : "serve");
  const deploymentProfile =
    raw.BEA_DEPLOYMENT_PROFILE ?? (raw.APP_MODE === "demo" ? "demo" : "enterprise");
  const authProvider =
    raw.BEA_AUTH_PROVIDER ??
    (deploymentProfile === "demo" || deploymentProfile === "owner-evaluation"
      ? "demo"
      : deploymentProfile === "local-live"
        ? "local-owner"
        : "microsoft-entra");
  const environment: ServerEnvironment = {
    nodeEnv: raw.NODE_ENV,
    runtimeMode,
    appMode: raw.APP_MODE,
    deploymentProfile,
    authProvider,
    appBaseUrl: raw.APP_BASE_URL,
    secureCookies: new URL(raw.APP_BASE_URL).protocol === "https:",
    databaseDriver,
    demoDatabasePath: raw.DEMO_DATABASE_PATH,
    workerDemoDatabasePath: raw.WORKER_DEMO_DATABASE_PATH,
    demoAuthEnabled: raw.DEMO_AUTH_ENABLED ?? raw.APP_MODE === "demo",
    sessionTtlMinutes: raw.SESSION_TTL_MINUTES,
    workerMode,
    workerQueueAdapter,
    workerPollIntervalMs: raw.WORKER_POLL_INTERVAL_MS,
    workerHealthPort: raw.WORKER_HEALTH_PORT,
    logLevel: raw.LOG_LEVEL,
  };

  if (raw.DATABASE_URL !== undefined) {
    Object.assign(environment, { databaseUrl: raw.DATABASE_URL });
  }
  if (raw.SESSION_SECRET !== undefined) {
    Object.assign(environment, { sessionSecret: raw.SESSION_SECRET });
  }
  if (raw.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN !== undefined) {
    Object.assign(environment, {
      ownerEvaluationPublicOrigin: parseExactHttpOrigin(
        raw.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN,
        "BEA_OWNER_EVALUATION_PUBLIC_ORIGIN",
      ),
    });
  }

  return environment;
}

export function isOwnerEvaluationRuntime(environment: {
  readonly deploymentProfile: ServerEnvironment["deploymentProfile"];
}): boolean {
  return environment.deploymentProfile === "owner-evaluation";
}

export function requiresLiveOpenAiProvider(environment: {
  readonly appMode: ServerEnvironment["appMode"];
  readonly deploymentProfile: ServerEnvironment["deploymentProfile"];
}): boolean {
  return environment.appMode === "production" || isOwnerEvaluationRuntime(environment);
}

export function toPublicEnvironment(environment: ServerEnvironment): PublicEnvironment {
  return {
    runtimeMode: environment.runtimeMode,
    appMode: environment.appMode,
    productionMode: environment.runtimeMode === "production",
    demoMode: environment.appMode === "demo" && !isOwnerEvaluationRuntime(environment),
    ownerEvaluation: isOwnerEvaluationRuntime(environment),
    nodeEnv: environment.nodeEnv,
  };
}
