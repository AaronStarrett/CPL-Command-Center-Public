import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_SCHEMA_VERSION,
  createDefaultProductionConfig,
  migrateProductionConfig,
  productionConfigToEnvironment,
  readProductionConfig,
  validateProductionConfig,
  writeProductionConfigAtomic,
} from "../../scripts/phase134/production-config.mjs";
import {
  DEFAULT_PRODUCTION_PORTS,
  validateProductionPorts,
  validateProfileOrigin,
} from "../../scripts/phase134/production-profile.mjs";
import {
  createProductionPaths,
  isPathContained,
} from "../../scripts/phase134/production-paths.mjs";

const temporaryDirectories = [];

function fixture() {
  const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-config-"));
  temporaryDirectories.push(localAppData);
  const paths = createProductionPaths({ localAppData });
  return { paths, config: createDefaultProductionConfig({ paths }) };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("Phase 1.3.4 strict production paths and config", () => {
  it("keeps every user-local runtime path inside the BEA product root", () => {
    const { paths } = fixture();
    for (const [key, value] of Object.entries(paths)) {
      if (key === "repositoryRoot" || key === "productRoot") continue;
      expect(isPathContained(paths.productRoot, value), key).toBe(true);
    }
    expect(paths.nodeExecutable).toContain("node-v24.19.0-win-x64");
    expect(paths.pnpmExecutable).toContain("toolchain");
  });

  it("validates the exact Local Live shape, profile, ports, and secure defaults", () => {
    const { config, paths } = fixture();
    expect(config).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      deploymentProfile: "local-live",
      appBaseUrl: "https://bea.localhost:3443",
      hostname: "bea.localhost",
      ports: DEFAULT_PRODUCTION_PORTS,
      database: { driver: "postgres", tlsMode: "prefer", toolsDirectory: null },
      queue: { adapter: "pg-boss" },
      worker: { mode: "serve" },
      authentication: { provider: "local-owner", ownerUsername: "owner" },
      paths: { backupRetentionCount: 14 },
      features: { webSearchEnabled: false, realtimeEnabled: false },
    });
    expect(validateProductionConfig(config, { productRoot: paths.productRoot })).toEqual(config);
  });

  it("rejects unknown fields, port collisions, unsafe origins, and Enterprise local auth", () => {
    const { paths, config } = fixture();
    expect(() =>
      validateProductionConfig(
        { ...config, SESSION_SECRET: "must-not-appear" },
        {
          productRoot: paths.productRoot,
        },
      ),
    ).toThrow(/unknown fields/iu);
    expect(() =>
      validateProductionPorts({
        ...DEFAULT_PRODUCTION_PORTS,
        control: DEFAULT_PRODUCTION_PORTS.web,
      }),
    ).toThrow(/distinct/iu);
    expect(() =>
      validateProfileOrigin({
        deploymentProfile: "local-live",
        appBaseUrl: "https://public.example:3443",
        hostname: "public.example",
      }),
    ).toThrow(/localhost/iu);
    expect(() =>
      validateProductionConfig(
        {
          ...config,
          deploymentProfile: "enterprise",
          appBaseUrl: "https://bea.example:3443",
          hostname: "bea.example",
        },
        { productRoot: paths.productRoot },
      ),
    ).toThrow(/microsoft-entra/iu);
    expect(() =>
      validateProductionConfig(
        {
          ...config,
          database: { ...config.database, toolsDirectory: "relative\\postgres\\bin" },
        },
        { productRoot: paths.productRoot },
      ),
    ).toThrow(/database\.toolsDirectory must be an absolute path/iu);
    expect(() =>
      validateProductionConfig(
        {
          ...config,
          paths: { ...config.paths, backupRetentionCount: 0 },
        },
        { productRoot: paths.productRoot },
      ),
    ).toThrow(/integer from 1 through 365/iu);
    expect(() =>
      validateProductionConfig(
        {
          ...config,
          https: { ...config.https, pfxPath: join(paths.productRoot, "outside.pfx") },
        },
        { productRoot: paths.productRoot },
      ),
    ).toThrow(/protected certificate directory/iu);
  });

  it("writes and replaces strict config atomically without plaintext secret fields", () => {
    const { paths, config } = fixture();
    writeProductionConfigAtomic(config, {
      filePath: paths.configFile,
      allowedRoot: paths.configDirectory,
      productRoot: paths.productRoot,
    });
    const updated = {
      ...config,
      features: { ...config.features, webSearchEnabled: true },
    };
    writeProductionConfigAtomic(updated, {
      filePath: paths.configFile,
      allowedRoot: paths.configDirectory,
      productRoot: paths.productRoot,
    });
    expect(
      readProductionConfig({ filePath: paths.configFile, productRoot: paths.productRoot }),
    ).toMatchObject({ features: { webSearchEnabled: true } });
    const serialized = readFileSync(paths.configFile, "utf8");
    expect(serialized).not.toMatch(/SESSION_SECRET|DATABASE_URL|OPENAI_API_KEY/iu);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("migrates schema zero deterministically and exports only non-secret child environment", () => {
    const { config, paths } = fixture();
    const legacy = { ...config, schemaVersion: 0 };
    delete legacy.features;
    const migrated = migrateProductionConfig(legacy);
    expect(migrated).toMatchObject({
      schemaVersion: 1,
      database: { toolsDirectory: null },
      paths: { backupRetentionCount: 14 },
      features: { webSearchEnabled: false, realtimeEnabled: false },
    });
    const environment = productionConfigToEnvironment(config, {
      productRoot: paths.productRoot,
    });
    expect(environment).toMatchObject({
      APP_MODE: "production",
      BEA_RUNTIME_MODE: "production",
      BEA_DISABLE_ENV_FILE: "true",
      DEMO_AUTH_ENABLED: "false",
      BEA_DEPLOYMENT_PROFILE: "local-live",
    });
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("SESSION_SECRET");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });
});
