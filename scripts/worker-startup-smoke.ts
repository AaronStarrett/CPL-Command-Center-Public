import { runWorker } from "../apps/worker/src/runtime.js";

const healthPort = 33_101;
const controller = new AbortController();

async function waitUntilClosed(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error("Worker health server did not stop within five seconds.");
}

const environment: Record<string, string | undefined> = {
  ...process.env,
  NODE_ENV: "test",
  APP_MODE: "demo",
  APP_BASE_URL: "http://127.0.0.1:3000",
  BEA_DEPLOYMENT_PROFILE: "demo",
  BEA_OWNER_EVALUATION: "",
  BEA_OWNER_EVALUATION_AUTHORITY: "",
  BEA_OWNER_EVALUATION_PUBLIC_ORIGIN: "",
  BEA_PREVIEW_MODE: "",
  DATABASE_DRIVER: "pglite",
  DEMO_DATABASE_PATH: "memory://",
  DEMO_AUTH_ENABLED: "true",
  WORKER_MODE: "serve",
  WORKER_QUEUE_ADAPTER: "inline",
  WORKER_POLL_INTERVAL_MS: "3600000",
  WORKER_HEALTH_PORT: String(healthPort),
  LOG_LEVEL: "silent",
  OPENAI_API_KEY: "",
};

async function main(): Promise<void> {
  try {
    const result = await runWorker(["--serve"], environment, controller.signal);
    if (
      result.mode !== "serve" ||
      result.status !== "serving" ||
      result.healthPort !== healthPort
    ) {
      throw new Error(`Worker returned an unexpected startup result: ${JSON.stringify(result)}`);
    }

    const url = `http://127.0.0.1:${healthPort}/health`;
    const response = await fetch(url);
    const snapshot = (await response.json()) as {
      readonly service?: string;
      readonly status?: string;
    };
    if (!response.ok || snapshot.service !== "bea-worker" || snapshot.status !== "healthy") {
      throw new Error(
        `Worker health check failed: HTTP ${response.status} ${JSON.stringify(snapshot)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({ code: "BEA_WORKER_STARTUP_SMOKE_OK", healthPort, snapshot })}\n`,
    );
    controller.abort();
    await waitUntilClosed(url);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

void main();
