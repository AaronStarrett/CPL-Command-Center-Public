import "server-only";

export const PHASE133_PRODUCTION_PRESENTATION_TEST_AUTHORITY =
  "phase1-3-3-production-presentation" as const;

type PresentationTestEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * TEST-ONLY presentation authority. This never changes BEA's runtime mode, authentication,
 * persistence, provider state, or production-readiness evidence.
 */
export function isPhase133ProductionPresentationTest(
  environment: PresentationTestEnvironment = process.env,
): boolean {
  return (
    environment.NODE_ENV === "test" &&
    environment.APP_MODE === "demo" &&
    environment.BEA_RUNTIME_MODE === "" &&
    environment.APP_BASE_URL === "http://127.0.0.1:3132" &&
    environment.BEA_DISABLE_ENV_FILE === "true" &&
    environment.DATABASE_DRIVER === "pglite" &&
    environment.DEMO_AUTH_ENABLED === "true" &&
    environment.DEMO_DATABASE_PATH === "memory://" &&
    environment.WORKER_QUEUE_ADAPTER === "inline" &&
    environment.OPENAI_API_KEY === "" &&
    environment.BEA_PHASE133_PRESENTATION_TEST_MODE === "true" &&
    environment.BEA_PHASE133_PRESENTATION_TEST_AUTHORITY ===
      PHASE133_PRODUCTION_PRESENTATION_TEST_AUTHORITY
  );
}
