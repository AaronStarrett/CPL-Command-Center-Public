import { defineConfig, devices } from "@playwright/test";

interface BeaPlaywrightConfigOptions {
  readonly browserMediaTestMode: boolean;
  readonly productionPresentationTestMode?: boolean;
  readonly phase20LeadsTestMode?: boolean;
  readonly phase21CopresenterTestMode?: boolean;
  readonly phase22CopresenterTestMode?: boolean;
  readonly phase23DigitalWorkforceTestMode?: boolean;
  readonly phase30OperationsTestMode?: boolean;
  readonly phase31aConfigurationTestMode?: boolean;
  readonly phase32aWorkTestMode?: boolean;
  readonly phase33aProposalsTestMode?: boolean;
  readonly phase34aGuidedExperienceTestMode?: boolean;
}

const fallbackBaseURL = "http://127.0.0.1:3000";
const configuredBaseURL = process.env.APP_BASE_URL ?? fallbackBaseURL;
const configuredBase = new URL(configuredBaseURL);
if (
  configuredBase.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(configuredBase.hostname) ||
  configuredBase.username !== "" ||
  configuredBase.password !== "" ||
  configuredBase.pathname !== "/" ||
  configuredBase.search !== "" ||
  configuredBase.hash !== "" ||
  configuredBase.port === ""
) {
  throw new Error(
    "Playwright APP_BASE_URL must be an explicit credential-free loopback HTTP origin.",
  );
}
const defaultBaseURL = configuredBase.origin;
const defaultWebPort = configuredBase.port;
const configuredWorkerHealthPort = process.env.WORKER_HEALTH_PORT ?? "3001";
if (!/^\d{1,5}$/u.test(configuredWorkerHealthPort)) {
  throw new Error("Playwright WORKER_HEALTH_PORT must be an explicit numeric port.");
}
const parsedWorkerHealthPort = Number(configuredWorkerHealthPort);
if (parsedWorkerHealthPort < 1 || parsedWorkerHealthPort > 65_535) {
  throw new Error("Playwright WORKER_HEALTH_PORT must be between 1 and 65535.");
}
const phase133PresentationBaseURL = "http://127.0.0.1:3132";
const phase133PresentationAuthority = "phase1-3-3-production-presentation";
const phase133PresentationTag = /@phase133-production-presentation/u;
const ordinaryExcludedTags =
  /(?:@webrtc|@phase133-production-presentation|@phase20-leads|@phase21-copresenter|@phase22-copresenter|@phase23-workforce|@phase30-operations|@phase31a-configuration|@phase32a-work|@phase33a-proposals|@phase34a-guided)/u;

function configurePlaywrightEnvironment(
  browserMediaTestMode: boolean,
  productionPresentationTestMode: boolean,
) {
  if (browserMediaTestMode && productionPresentationTestMode) {
    throw new Error("Playwright TEST-ONLY presentation and browser media modes are isolated.");
  }

  const browserMediaFixture = browserMediaTestMode
    ? process.env.BEA_BROWSER_MEDIA_TEST_WAV_PATH?.replaceAll("\\", "/")
    : undefined;
  const browserMediaFixtureSha256 = browserMediaTestMode
    ? process.env.BEA_BROWSER_MEDIA_TEST_WAV_SHA256
    : undefined;

  if (
    browserMediaTestMode &&
    (process.env.APP_MODE !== "demo" ||
      process.env.BEA_DISABLE_ENV_FILE !== "true" ||
      process.env.BEA_BROWSER_MEDIA_TEST_MODE !== "true" ||
      process.env.BEA_BROWSER_MEDIA_TEST_AUTHORITY !== "phase1-2-gate30" ||
      !browserMediaFixture ||
      !/^[a-f0-9]{64}$/u.test(browserMediaFixtureSha256 ?? ""))
  ) {
    throw new Error(
      "Gate 30 browser media mode requires its exact Demo authority and generated WAV fixture metadata.",
    );
  }

  process.env.APP_MODE = "demo";
  process.env.BEA_DISABLE_ENV_FILE = "true";
  process.env.OPENAI_API_KEY = "";
  process.env.BEA_BROWSER_MEDIA_TEST_MODE = browserMediaTestMode ? "true" : "false";
  process.env.BEA_BROWSER_MEDIA_TEST_AUTHORITY = browserMediaTestMode ? "phase1-2-gate30" : "";
  process.env.BEA_PHASE133_PRESENTATION_TEST_MODE = productionPresentationTestMode
    ? "true"
    : "false";
  process.env.BEA_PHASE133_PRESENTATION_TEST_AUTHORITY = productionPresentationTestMode
    ? phase133PresentationAuthority
    : "";
  if (productionPresentationTestMode) {
    process.env.NODE_ENV = "test";
    process.env.BEA_RUNTIME_MODE = "";
    process.env.APP_BASE_URL = phase133PresentationBaseURL;
    process.env.DATABASE_DRIVER = "pglite";
    process.env.DEMO_AUTH_ENABLED = "true";
    process.env.DEMO_DATABASE_PATH = "memory://";
    process.env.WORKER_QUEUE_ADAPTER = "inline";
  }
  if (!browserMediaTestMode) {
    delete process.env.BEA_BROWSER_MEDIA_TEST_WAV_PATH;
    delete process.env.BEA_BROWSER_MEDIA_TEST_WAV_SHA256;
  }

  return { browserMediaFixture };
}

export function createBeaPlaywrightConfig({
  browserMediaTestMode,
  productionPresentationTestMode = false,
  phase20LeadsTestMode = false,
  phase21CopresenterTestMode = false,
  phase22CopresenterTestMode = false,
  phase23DigitalWorkforceTestMode = false,
  phase30OperationsTestMode = false,
  phase31aConfigurationTestMode = false,
  phase32aWorkTestMode = false,
  phase33aProposalsTestMode = false,
  phase34aGuidedExperienceTestMode = false,
}: BeaPlaywrightConfigOptions) {
  if (phase20LeadsTestMode && (browserMediaTestMode || productionPresentationTestMode)) {
    throw new Error("Phase 2.0 lead browser tests are isolated from media and presentation modes.");
  }
  if (
    phase21CopresenterTestMode &&
    (browserMediaTestMode || productionPresentationTestMode || phase20LeadsTestMode)
  ) {
    throw new Error(
      "Phase 2.1 co-presenter browser tests are isolated from media, presentation, and lead modes.",
    );
  }
  if (
    phase22CopresenterTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode)
  ) {
    throw new Error(
      "Phase 2.2 co-presenter browser tests are isolated from media, presentation, lead, and Phase 2.1 modes.",
    );
  }
  if (
    phase23DigitalWorkforceTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode ||
      phase22CopresenterTestMode)
  ) {
    throw new Error(
      "Phase 2.3 Digital Workforce browser tests are isolated from media, presentation, lead, and Phase 2.1/2.2 modes.",
    );
  }
  if (
    phase30OperationsTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode ||
      phase22CopresenterTestMode ||
      phase23DigitalWorkforceTestMode)
  ) {
    throw new Error(
      "Phase 3.0 operations browser tests are isolated from media, presentation, lead, and earlier phase modes.",
    );
  }
  if (
    phase31aConfigurationTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode ||
      phase22CopresenterTestMode ||
      phase23DigitalWorkforceTestMode ||
      phase30OperationsTestMode)
  ) {
    throw new Error(
      "Phase 3.1A configuration browser tests are isolated from media, presentation, lead, and earlier phase modes.",
    );
  }
  if (
    phase32aWorkTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode ||
      phase22CopresenterTestMode ||
      phase23DigitalWorkforceTestMode ||
      phase30OperationsTestMode ||
      phase31aConfigurationTestMode)
  ) {
    throw new Error(
      "Phase 3.2A work browser tests are isolated from media, presentation, lead, and earlier phase modes.",
    );
  }
  if (
    phase33aProposalsTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode ||
      phase22CopresenterTestMode ||
      phase23DigitalWorkforceTestMode ||
      phase30OperationsTestMode ||
      phase31aConfigurationTestMode ||
      phase32aWorkTestMode)
  ) {
    throw new Error(
      "Phase 3.3A proposal browser tests are isolated from media, presentation, lead, and earlier phase modes.",
    );
  }
  if (
    phase34aGuidedExperienceTestMode &&
    (browserMediaTestMode ||
      productionPresentationTestMode ||
      phase20LeadsTestMode ||
      phase21CopresenterTestMode ||
      phase22CopresenterTestMode ||
      phase23DigitalWorkforceTestMode ||
      phase30OperationsTestMode ||
      phase31aConfigurationTestMode ||
      phase32aWorkTestMode ||
      phase33aProposalsTestMode)
  ) {
    throw new Error(
      "Phase 3.4A guided experience browser tests are isolated from media, presentation, lead, and earlier phase modes.",
    );
  }
  const { browserMediaFixture } = configurePlaywrightEnvironment(
    browserMediaTestMode,
    productionPresentationTestMode,
  );
  const browserMediaTestAuthority = browserMediaTestMode ? "phase1-2-gate30" : "";
  const presentationTestAuthority = productionPresentationTestMode
    ? phase133PresentationAuthority
    : "";
  const baseURL = productionPresentationTestMode ? phase133PresentationBaseURL : defaultBaseURL;
  const webPort = productionPresentationTestMode ? "3132" : defaultWebPort;
  const workerHealthPort = productionPresentationTestMode ? "3133" : String(parsedWorkerHealthPort);
  const inheritedEnvironmentEntries = Object.entries(process.env);
  const inheritedNodeOptions = [
    ...new Set(
      inheritedEnvironmentEntries
        .filter(([key]) => key.toUpperCase() === "NODE_OPTIONS")
        .map(([, value]) => value)
        .filter(Boolean),
    ),
  ].join(" ");
  const warningSuppressingNodeOptions = [
    "--disable-warning",
    "--no-deprecation",
    "--no-warnings",
    "--redirect-warnings",
  ];
  const blockedNodeOption = warningSuppressingNodeOptions.find((option) =>
    inheritedNodeOptions.toLowerCase().includes(option),
  );

  if (blockedNodeOption) {
    throw new Error(`Playwright refuses warning-suppressing NODE_OPTIONS: ${blockedNodeOption}`);
  }

  const inheritedWarningRedirect = inheritedEnvironmentEntries.find(
    ([key, value]) =>
      Boolean(value) && ["NODE_NO_WARNINGS", "NODE_REDIRECT_WARNINGS"].includes(key.toUpperCase()),
  );

  if (inheritedWarningRedirect) {
    throw new Error(
      `Playwright refuses inherited warning control: ${inheritedWarningRedirect[0]}.`,
    );
  }

  const nonInteractiveColorEnvironment = {
    FORCE_COLOR: "0",
  };
  const warningVisibleNodeOptions = inheritedNodeOptions.includes("--trace-warnings")
    ? inheritedNodeOptions
    : [inheritedNodeOptions, "--trace-warnings"].filter(Boolean).join(" ");
  const warningVisibleEnvironment = {
    NODE_NO_WARNINGS: "",
    NODE_OPTIONS: warningVisibleNodeOptions,
    NODE_REDIRECT_WARNINGS: "",
  };
  const cloudRepositoryBoundaryEnvironment =
    process.env.CI === "true" && process.env.BEA_REPOSITORY_ROOT
      ? { CI: "true", BEA_REPOSITORY_ROOT: process.env.BEA_REPOSITORY_ROOT }
      : {};
  const traceMode = browserMediaTestMode ? "off" : "retain-on-failure";

  return defineConfig({
    testDir: "./tests/e2e",
    grep: productionPresentationTestMode
      ? phase133PresentationTag
      : browserMediaTestMode
        ? /@webrtc/u
        : phase20LeadsTestMode
          ? /@phase20-leads/u
          : phase21CopresenterTestMode
            ? /@phase21-copresenter/u
            : phase22CopresenterTestMode
              ? /@phase22-copresenter/u
              : phase23DigitalWorkforceTestMode
                ? /@phase23-workforce/u
                : phase30OperationsTestMode
                  ? /@phase30-operations/u
                  : phase31aConfigurationTestMode
                    ? /@phase31a-configuration/u
                    : phase32aWorkTestMode
                      ? /@phase32a-work/u
                      : phase33aProposalsTestMode
                        ? /@phase33a-proposals/u
                        : phase34aGuidedExperienceTestMode
                          ? /@phase34a-guided/u
                          : undefined,
    grepInvert: productionPresentationTestMode
      ? /@webrtc/u
      : browserMediaTestMode
        ? phase133PresentationTag
        : phase20LeadsTestMode ||
            phase21CopresenterTestMode ||
            phase22CopresenterTestMode ||
            phase23DigitalWorkforceTestMode ||
            phase30OperationsTestMode ||
            phase31aConfigurationTestMode ||
            phase32aWorkTestMode ||
            phase33aProposalsTestMode ||
            phase34aGuidedExperienceTestMode
          ? /(?:@webrtc|@phase133-production-presentation)/u
          : ordinaryExcludedTags,
    timeout: 90_000,
    expect: { timeout: 30_000 },
    fullyParallel: false,
    forbidOnly: true,
    retries: 0,
    workers: 1,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
      baseURL,
      launchOptions: {
        args: browserMediaTestMode
          ? [
              "--enable-automation",
              "--autoplay-policy=no-user-gesture-required",
              "--disable-features=WebRtcHideLocalIpsWithMdns",
              "--use-fake-device-for-media-stream",
              `--use-file-for-fake-audio-capture=${browserMediaFixture}`,
            ]
          : [],
      },
      permissions: browserMediaTestMode ? ["microphone"] : [],
      screenshot: "only-on-failure",
      trace: traceMode,
    },
    projects: [
      {
        name: productionPresentationTestMode
          ? "chromium-production-presentation"
          : "chromium-desktop",
        use: {
          ...devices["Desktop Chrome"],
          browserName: "chromium",
          ...(browserMediaTestMode ? { channel: "chromium" as const, trace: "off" as const } : {}),
        },
      },
    ],
    webServer: [
      {
        command: "pnpm --filter @bea/worker start",
        env: {
          ...nonInteractiveColorEnvironment,
          ...warningVisibleEnvironment,
          ...cloudRepositoryBoundaryEnvironment,
          APP_MODE: "demo",
          BEA_PHASE133_PRESENTATION_TEST_AUTHORITY: presentationTestAuthority,
          BEA_PHASE133_PRESENTATION_TEST_MODE: productionPresentationTestMode ? "true" : "false",
          BEA_BROWSER_MEDIA_TEST_AUTHORITY: browserMediaTestAuthority,
          BEA_BROWSER_MEDIA_TEST_MODE: browserMediaTestMode ? "true" : "false",
          BEA_BROWSER_MEDIA_TEST_WAV_PATH: browserMediaFixture ?? "",
          BEA_DISABLE_ENV_FILE: "true",
          BEA_DEPLOYMENT_PROFILE: "demo",
          BEA_OWNER_EVALUATION: "",
          BEA_OWNER_EVALUATION_AUTHORITY: "",
          BEA_OWNER_EVALUATION_PUBLIC_ORIGIN: "",
          BEA_PREVIEW_MODE: "",
          DATABASE_DRIVER: "pglite",
          DEMO_DATABASE_PATH: "memory://",
          WORKER_DEMO_DATABASE_PATH: "memory://",
          WORKER_MODE: "serve",
          WORKER_QUEUE_ADAPTER: "inline",
          WORKER_POLL_INTERVAL_MS: "3600000",
          WORKER_HEALTH_PORT: workerHealthPort,
          LOG_LEVEL: "silent",
          OPENAI_API_KEY: "",
          ...(productionPresentationTestMode
            ? {
                APP_BASE_URL: baseURL,
                BEA_RUNTIME_MODE: "",
                DATABASE_DRIVER: "pglite",
                DEMO_AUTH_ENABLED: "true",
                NODE_ENV: "test",
                WORKER_QUEUE_ADAPTER: "inline",
              }
            : {}),
        },
        reuseExistingServer: process.env.PW_REUSE_SERVER === "1",
        timeout: 180_000,
        url: `http://127.0.0.1:${workerHealthPort}/health`,
      },
      {
        command: `pnpm --filter @bea/web start --port ${webPort}`,
        env: {
          ...nonInteractiveColorEnvironment,
          ...warningVisibleEnvironment,
          ...cloudRepositoryBoundaryEnvironment,
          APP_BASE_URL: baseURL,
          APP_MODE: "demo",
          BEA_PHASE133_PRESENTATION_TEST_AUTHORITY: presentationTestAuthority,
          BEA_PHASE133_PRESENTATION_TEST_MODE: productionPresentationTestMode ? "true" : "false",
          BEA_BROWSER_MEDIA_TEST_AUTHORITY: browserMediaTestAuthority,
          BEA_BROWSER_MEDIA_TEST_MODE: browserMediaTestMode ? "true" : "false",
          BEA_BROWSER_MEDIA_TEST_WAV_PATH: browserMediaFixture ?? "",
          BEA_DISABLE_ENV_FILE: "true",
          BEA_DEPLOYMENT_PROFILE: "demo",
          BEA_OWNER_EVALUATION: "",
          BEA_OWNER_EVALUATION_AUTHORITY: "",
          BEA_OWNER_EVALUATION_PUBLIC_ORIGIN: "",
          BEA_PREVIEW_MODE: "",
          DATABASE_DRIVER: "pglite",
          DEMO_AUTH_ENABLED: "true",
          DEMO_DATABASE_PATH: "memory://",
          WORKER_HEALTH_PORT: workerHealthPort,
          LOG_LEVEL: "silent",
          OPENAI_API_KEY: "",
          ...(productionPresentationTestMode
            ? {
                BEA_RUNTIME_MODE: "",
                NODE_ENV: "test",
                WORKER_QUEUE_ADAPTER: "inline",
              }
            : {}),
        },
        reuseExistingServer: process.env.PW_REUSE_SERVER === "1",
        timeout: 180_000,
        url: baseURL + "/sign-in",
      },
    ],
  });
}
