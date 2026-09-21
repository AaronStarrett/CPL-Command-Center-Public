import { describe, expect, it } from "vitest";
import {
  EnvironmentValidationError,
  findRepositoryRoot,
  loadRepositoryEnvironment,
  parseEnvironment,
  parseEnvFile,
} from "../../packages/config/src/index.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("environment validation", () => {
  it("rejects synthetic development and retains an explicit test boundary", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        BEA_RUNTIME_MODE: "development",
        APP_MODE: "demo",
      }),
    ).toThrow(/isolated NODE_ENV=test/u);

    expect(
      parseEnvironment({
        NODE_ENV: "test",
        BEA_RUNTIME_MODE: "production",
        APP_MODE: "demo",
      }).runtimeMode,
    ).toBe("test");
  });

  it("rejects a production runtime that selects Demo application mode", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        BEA_RUNTIME_MODE: "production",
        APP_MODE: "demo",
      }),
    ).toThrow(/BEA production runtime requires APP_MODE=production/u);
  });

  it("rejects production application mode under an explicit development runtime", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        BEA_RUNTIME_MODE: "development",
        APP_MODE: "production",
      }),
    ).toThrow(/cannot run with BEA_RUNTIME_MODE=development/u);
  });

  it("accepts test fixture env files with blank production-only values", () => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      APP_MODE: "demo",
      DATABASE_DRIVER: "",
      DATABASE_URL: "  ",
      SESSION_SECRET: "",
      WORKER_QUEUE_ADAPTER: "",
      DEMO_AUTH_ENABLED: "true",
    });
    expect(environment.databaseDriver).toBe("pglite");
    expect(environment.databaseUrl).toBeUndefined();
    expect(environment.sessionSecret).toBeUndefined();
    expect(environment.workerQueueAdapter).toBe("inline");
    expect(environment.workerDemoDatabasePath).toBe("memory://");
    expect(environment.workerHealthPort).toBe(3001);
    expect(environment.secureCookies).toBe(false);
  });

  it("rejects an optimized Next server using demo identities over local HTTP", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        APP_MODE: "demo",
        APP_BASE_URL: "http://127.0.0.1:33100",
        DATABASE_DRIVER: "pglite",
        DEMO_AUTH_ENABLED: "true",
        WORKER_QUEUE_ADAPTER: "inline",
      }),
    ).toThrow(/isolated NODE_ENV=test/u);
  });

  it("fails closed when production requirements are missing", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        APP_MODE: "production",
        DEMO_AUTH_ENABLED: "false",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("accepts an explicitly configured production boundary", () => {
    const environment = parseEnvironment({
      NODE_ENV: "development",
      APP_MODE: "production",
      APP_BASE_URL: "https://command-center.example.invalid",
      DEMO_AUTH_ENABLED: "false",
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://database.example.invalid/bea",
      SESSION_SECRET: "example-only-session-secret-32-characters",
      WORKER_QUEUE_ADAPTER: "pg-boss",
    });
    expect(environment.appMode).toBe("production");
    expect(environment.demoAuthEnabled).toBe(false);
    expect(environment.secureCookies).toBe(true);
  });

  it("rejects production mode over an insecure public base URL", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        APP_MODE: "production",
        APP_BASE_URL: "http://command-center.example.invalid",
        DEMO_AUTH_ENABLED: "false",
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: "postgresql://database.example.invalid/bea",
        SESSION_SECRET: "example-only-session-secret-32-characters",
        WORKER_QUEUE_ADAPTER: "pg-boss",
      }),
    ).toThrow(/HTTPS APP_BASE_URL/u);
  });

  it.each([
    "ftp://command-center.example.invalid",
    "https://owner:password@command-center.example.invalid",
    "https://command-center.example.invalid/operations",
    "https://command-center.example.invalid?mode=demo",
    "https://command-center.example.invalid#status",
    "https://command-center.example.invalid/?",
    "https://command-center.example.invalid/#",
  ])("rejects APP_BASE_URL values that are not origin-only HTTP(S) URLs: %s", (appBaseUrl) => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "test",
        APP_MODE: "demo",
        APP_BASE_URL: appBaseUrl,
      }),
    ).toThrow(/APP_BASE_URL must be an HTTP\(S\) origin/u);
  });

  it.each(["http://localhost:3000", "https://command-center.example.invalid/"])(
    "accepts an origin-only APP_BASE_URL: %s",
    (appBaseUrl) => {
      expect(
        parseEnvironment({ NODE_ENV: "test", APP_MODE: "demo", APP_BASE_URL: appBaseUrl })
          .appBaseUrl,
      ).toBe(appBaseUrl);
    },
  );

  it.each([
    ["DEMO_DATABASE_PATH", "../outside-demo-pglite"],
    ["WORKER_DEMO_DATABASE_PATH", resolve(process.cwd(), "..", "outside-worker-pglite")],
    [
      "DEMO_DATABASE_PATH",
      "C:\\CPL-Dev\\Cyber Pirate Labs Command Center\\.data\\protected-pglite",
    ],
  ] as const)("rejects repository-external PGlite ownership through %s", (key, path) => {
    expect(() =>
      loadRepositoryEnvironment({
        startDirectory: process.cwd(),
        processEnvironment: {
          NODE_ENV: "test",
          APP_MODE: "demo",
          DATABASE_DRIVER: "pglite",
          [key]: path,
        },
      }),
    ).toThrow(/PGlite data path must resolve within the BEA repository root/u);
  });

  it("rejects one persistent PGlite path shared by web and a serve-mode worker", () => {
    expect(() =>
      loadRepositoryEnvironment({
        startDirectory: process.cwd(),
        processEnvironment: {
          NODE_ENV: "test",
          APP_MODE: "demo",
          DATABASE_DRIVER: "pglite",
          WORKER_MODE: "serve",
          DEMO_DATABASE_PATH: ".data/shared-owner",
          WORKER_DEMO_DATABASE_PATH: ".data/../.data/shared-owner",
        },
      }),
    ).toThrow(/must use distinct data paths/u);
  });

  it("parses env files without revealing or expanding values", () => {
    expect(parseEnvFile("# comment\nDATABASE_URL=\nAPP_MODE=demo\nQUOTED='safe value'\n")).toEqual({
      DATABASE_URL: "",
      APP_MODE: "demo",
      QUOTED: "safe value",
    });
    const expectedRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    expect(findRepositoryRoot(resolve(expectedRoot, "packages/config/src"))).toBe(expectedRoot);
  });

  it("BEA_DISABLE_ENV_FILE bypasses every env-file exists/read operation", () => {
    const touched: string[] = [];
    const loaded = loadRepositoryEnvironment({
      startDirectory: process.cwd(),
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        WORKER_DEMO_DATABASE_PATH: "memory://",
        BEA_DISABLE_ENV_FILE: "true",
        OPENAI_API_KEY: "",
      },
      envFileAccess: {
        exists(path) {
          touched.push(`exists:${path}`);
          throw new Error("env-file sentinel was touched");
        },
        read(path) {
          touched.push(`read:${path}`);
          throw new Error("env-file sentinel was touched");
        },
      },
    });

    expect(touched).toEqual([]);
    expect(loaded.envFileLoaded).toBe(false);
    expect(loaded.environment.appMode).toBe("demo");
    expect(loaded.secrets.status().openAiApiKey).toBe("not_configured");
  });

  it("gives the isolated Preview test fixture no readable or writable protected secret provider", () => {
    const loaded = loadRepositoryEnvironment({
      startDirectory: process.cwd(),
      processEnvironment: {
        NODE_ENV: "test",
        BEA_RUNTIME_MODE: "development",
        APP_MODE: "demo",
        BEA_DEPLOYMENT_PROFILE: "demo",
        BEA_AUTH_PROVIDER: "demo",
        APP_BASE_URL: "http://127.0.0.1:3100",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: ".data/bea-preview/pglite-web",
        WORKER_DEMO_DATABASE_PATH: ".data/bea-preview/pglite-worker",
        BEA_DISABLE_ENV_FILE: "true",
        BEA_PREVIEW_MODE: "true",
        BEA_PREVIEW_AUTHORITY: "Start-BEA-Preview.cmd",
        OPENAI_API_KEY: "",
        DATABASE_URL: "",
        BEA_PRODUCTION_SECRET_PATH: "",
      },
    });

    expect(loaded.environment).toMatchObject({
      appMode: "demo",
      authProvider: "demo",
      databaseDriver: "pglite",
      runtimeMode: "test",
    });
    expect(loaded.secrets.status()).toMatchObject({
      openAiApiKey: "not_configured",
      openAiApiKeySource: "none",
      windowsProtectedStorageAvailable: false,
    });
    expect(() => loaded.secrets.storeOpenAiApiKey("preview-cannot-store-a-real-api-key")).toThrow(
      /protected secret storage is unavailable/iu,
    );
  });

  it("rejects Preview when production credentials or a non-loopback origin are supplied", () => {
    const base = {
      NODE_ENV: "test",
      BEA_RUNTIME_MODE: "development",
      APP_MODE: "demo",
      BEA_DEPLOYMENT_PROFILE: "demo",
      BEA_AUTH_PROVIDER: "demo",
      APP_BASE_URL: "http://127.0.0.1:3100",
      DATABASE_DRIVER: "pglite",
      DEMO_DATABASE_PATH: ".data/bea-preview/pglite-web",
      WORKER_DEMO_DATABASE_PATH: ".data/bea-preview/pglite-worker",
      BEA_DISABLE_ENV_FILE: "true",
      BEA_PREVIEW_MODE: "true",
      BEA_PREVIEW_AUTHORITY: "Start-BEA-Preview.cmd",
    } as const;
    for (const unsafe of [
      { DATABASE_URL: "postgresql://production.invalid/bea" },
      { BEA_PRODUCTION_SECRET_PATH: "C:\\production-secrets.dpapi.json" },
      { OPENAI_API_KEY: "preview-must-not-accept-real-provider-keys" },
      { APP_BASE_URL: "http://0.0.0.0:3100" },
    ]) {
      expect(() =>
        loadRepositoryEnvironment({
          startDirectory: process.cwd(),
          processEnvironment: { ...base, ...unsafe },
        }),
      ).toThrow(/exact loopback Demo\/PGlite contract/iu);
    }
  });

  it("explicit loadEnvFile false takes precedence over process values", () => {
    let touched = false;
    const loaded = loadRepositoryEnvironment({
      startDirectory: process.cwd(),
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        WORKER_DEMO_DATABASE_PATH: "memory://",
        BEA_DISABLE_ENV_FILE: "false",
      },
      envFileAccess: {
        exists() {
          touched = true;
          return true;
        },
        read() {
          touched = true;
          return `OPENAI_API_KEY=${["s", "k", "-", "should-never-be-read"].join("")}`;
        },
      },
    });
    expect(touched).toBe(false);
    expect(loaded.envFileLoaded).toBe(false);
    expect(loaded.secrets.status().openAiApiKey).toBe("not_configured");
  });

  it("ambient BEA_DISABLE_ENV_FILE overrides a narrowed child environment and loadEnvFile true", () => {
    const prior = process.env.BEA_DISABLE_ENV_FILE;
    process.env.BEA_DISABLE_ENV_FILE = "true";
    let touched = false;
    try {
      const loaded = loadRepositoryEnvironment({
        startDirectory: process.cwd(),
        loadEnvFile: true,
        processEnvironment: {
          NODE_ENV: "test",
          APP_MODE: "demo",
          DATABASE_DRIVER: "pglite",
          DEMO_DATABASE_PATH: "memory://",
          WORKER_DEMO_DATABASE_PATH: "memory://",
          OPENAI_API_KEY: "",
        },
        envFileAccess: {
          exists() {
            touched = true;
            throw new Error("ambient disable sentinel was touched");
          },
          read() {
            touched = true;
            throw new Error("ambient disable sentinel was touched");
          },
        },
      });
      expect(touched).toBe(false);
      expect(loaded.envFileLoaded).toBe(false);
      expect(loaded.secrets.status().openAiApiKey).toBe("not_configured");
    } finally {
      if (prior === undefined) delete process.env.BEA_DISABLE_ENV_FILE;
      else process.env.BEA_DISABLE_ENV_FILE = prior;
    }
  });
});
