import type { NextConfig } from "next";
import { DirectoryReadCompatibilityPlugin } from "./lib/webpack-directory-read";
import { HostedDependencyInputsPlugin } from "./lib/webpack-dependency-inputs";
import path from "node:path";

export function permissionsPolicyForEnvironment(browserMediaTestMode: boolean): string {
  return browserMediaTestMode
    ? "camera=(), microphone=(self), geolocation=()"
    : "camera=(), microphone=(), geolocation=()";
}

export function browserMediaTestModeForEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    environment.APP_MODE === "demo" &&
    environment.BEA_DISABLE_ENV_FILE === "true" &&
    environment.BEA_BROWSER_MEDIA_TEST_MODE === "true" &&
    environment.BEA_BROWSER_MEDIA_TEST_AUTHORITY === "phase1-2-gate30"
  );
}

export function previewDistDirectoryForEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ".next-preview" | undefined {
  return environment.BEA_PREVIEW_MODE === "true" &&
    environment.BEA_PREVIEW_AUTHORITY === "Start-BEA-Preview.cmd" &&
    environment.APP_MODE === "demo" &&
    environment.BEA_RUNTIME_MODE === "development" &&
    environment.BEA_DISABLE_ENV_FILE === "true"
    ? ".next-preview"
    : undefined;
}

const permissionsPolicy = permissionsPolicyForEnvironment(
  browserMediaTestModeForEnvironment(process.env),
);
const previewDistDirectory = previewDistDirectoryForEnvironment(process.env);

const nextConfig: NextConfig = {
  ...(previewDistDirectory ? { distDir: previewDistDirectory } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@electric-sql/pglite"],
  transpilePackages: [
    // exFAT installs workspace sources as physical node_modules copies, so
    // every reachable TypeScript workspace needs explicit transpilation.
    "@bea/ai",
    "@bea/artifacts",
    "@bea/automation",
    "@bea/config",
    "@bea/database",
    "@bea/domain",
    "@bea/integrations",
    "@bea/observability",
    "@bea/platform",
    "@bea/security",
    "@bea/ui",
  ],
  webpack(config, { isServer }) {
    // Physical workspace copies change without a package-version bump. Snapshot
    // their files individually while retaining Next's cache for installed deps.
    config.snapshot = {
      ...config.snapshot,
      unmanagedPaths: [
        ...(config.snapshot?.unmanagedPaths ?? []),
        /[\\/]node_modules[\\/]@bea[\\/]/,
      ],
    };
    if (process.env.CPL_HOSTED_BUILD === "true") {
      config.plugins.push(
        new HostedDependencyInputsPlugin(path.join(__dirname, ".next", "cpl-dependency-inputs")),
      );
    }
    if (process.platform === "win32") {
      config.plugins.push(new DirectoryReadCompatibilityPlugin());
    }
    // Workspace packages use NodeNext-style `.js` specifiers while exporting
    // TypeScript source in Phase 0; webpack must resolve those to source files.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    if (isServer) {
      // PGlite performs Node filesystem reads using native URL instances. Keep
      // it outside webpack so those objects retain the Node runtime realm.
      config.externals.push({
        "@electric-sql/pglite": "commonjs @electric-sql/pglite",
      });
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: permissionsPolicy },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/api/operations/reports/:id/artifact",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
