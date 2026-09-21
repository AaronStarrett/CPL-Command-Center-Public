import { createServer, type Server } from "node:http";

export type WorkerHealthStatus = "starting" | "healthy" | "degraded" | "stopping";

export interface WorkerHealthSnapshot {
  readonly service: "bea-worker";
  readonly status: WorkerHealthStatus;
  readonly startedAt: string;
  readonly checkedAt: string;
  readonly lastWorkflowRun: {
    readonly id: string;
    readonly status: string;
    readonly reused: boolean;
    readonly finishedAt: string | null;
  } | null;
}

export class WorkerHealthMonitor {
  private status: WorkerHealthStatus = "starting";
  private lastWorkflowRun: WorkerHealthSnapshot["lastWorkflowRun"] = null;
  private readonly startedAt = new Date().toISOString();
  markHealthy(): void {
    this.status = "healthy";
  }
  markDegraded(): void {
    this.status = "degraded";
  }
  markStopping(): void {
    this.status = "stopping";
  }
  recordWorkflow(
    run: { id: string; status: string; finishedAt: string | null },
    reused: boolean,
  ): void {
    this.lastWorkflowRun = { id: run.id, status: run.status, reused, finishedAt: run.finishedAt };
    this.status = run.status === "succeeded" ? "healthy" : "degraded";
  }
  snapshot(): WorkerHealthSnapshot {
    return {
      service: "bea-worker",
      status: this.status,
      startedAt: this.startedAt,
      checkedAt: new Date().toISOString(),
      lastWorkflowRun: this.lastWorkflowRun,
    };
  }
}

export interface WorkerHealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startWorkerHealthServer(
  monitor: WorkerHealthMonitor,
  port: number,
  hostname = "127.0.0.1",
): Promise<WorkerHealthServer> {
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }));
      return;
    }
    const snapshot = monitor.snapshot();
    response.writeHead(snapshot.status === "healthy" ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(snapshot));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
