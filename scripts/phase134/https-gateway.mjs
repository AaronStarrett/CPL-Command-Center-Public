import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function required(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function parsePort(value, name) {
  if (!/^\d{1,5}$/u.test(value)) throw new Error(`${name} is invalid.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} is invalid.`);
  }
  return port;
}

function loopbackAddress(value) {
  if (value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1") return true;
  if (isIP(value ?? "") === 4) return value.startsWith("127.");
  return false;
}

export function normalizeExpectedHost(hostname, port) {
  const normalized = String(hostname).trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/u.test(normalized)) {
    throw new Error("Local Live HTTPS hostname must be a .localhost name.");
  }
  return `${normalized}:${String(port)}`;
}

export function buildForwardHeaders(source, expectedHost, webPort) {
  const headers = {};
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && lower !== "host" && lower !== "x-forwarded-host") {
      headers[lower] = value;
    }
  }
  return {
    ...headers,
    host: `${LOOPBACK_HOST}:${String(webPort)}`,
    "x-forwarded-for": LOOPBACK_HOST,
    "x-forwarded-host": expectedHost,
    "x-forwarded-proto": "https",
  };
}

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function log(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event, service: "bea-https-gateway", ...fields })}\n`,
  );
}

export function createGateway(options) {
  const expectedHost = normalizeExpectedHost(options.hostname, options.httpsPort);
  const proxy = options.proxyRequest ?? httpRequest;
  return createHttpsServer(options.tls, (request, response) => {
    const remoteAddress = request.socket.remoteAddress;
    if (!loopbackAddress(remoteAddress)) {
      writeJson(response, 403, { code: "LOOPBACK_REQUIRED", ok: false });
      return;
    }
    const requestHost = String(request.headers.host ?? "")
      .trim()
      .toLowerCase();
    if (requestHost !== expectedHost) {
      writeJson(response, 421, { code: "UNEXPECTED_HOST", ok: false });
      return;
    }
    if (request.method === "GET" && request.url === "/__bea_gateway_health") {
      writeJson(response, 200, {
        hostname: options.hostname,
        ok: true,
        service: "bea-https-gateway",
      });
      return;
    }

    const upstream = proxy(
      {
        headers: buildForwardHeaders(request.headers, expectedHost, options.webPort),
        host: LOOPBACK_HOST,
        method: request.method,
        path: request.url,
        port: options.webPort,
      },
      (upstreamResponse) => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined)
            responseHeaders[key] = value;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      },
    );
    upstream.setTimeout(120_000, () => upstream.destroy(new Error("Upstream timeout.")));
    upstream.once("error", (error) => {
      if (!response.headersSent) {
        writeJson(response, 502, { code: "UPSTREAM_UNAVAILABLE", ok: false });
      } else {
        response.destroy();
      }
      log("proxy.error", { errorName: error.name });
    });
    request.pipe(upstream);
  });
}

export async function startGateway(environment = process.env) {
  const hostname = required("BEA_HTTPS_HOSTNAME", environment).toLowerCase();
  const httpsPort = parsePort(required("BEA_HTTPS_PORT", environment), "BEA_HTTPS_PORT");
  const webPort = parsePort(required("PORT", environment), "PORT");
  const pfxPath = required("BEA_HTTPS_PFX_PATH", environment);
  const passphrase = required("BEA_HTTPS_PFX_PASSWORD", environment);
  const server = createGateway({
    hostname,
    httpsPort,
    webPort,
    tls: { pfx: readFileSync(pfxPath), passphrase, minVersion: "TLSv1.2" },
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  server.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: httpsPort, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log("gateway.ready", { hostname, httpsPort, upstreamPort: webPort });
  return server;
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll("\\", "/"))
) {
  let server;
  const close = () => {
    if (!server) return;
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  startGateway()
    .then((value) => {
      server = value;
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ code: "BEA_HTTPS_GATEWAY_FAILED", errorName: error instanceof Error ? error.name : "UnknownError" })}\n`,
      );
      process.exitCode = 1;
    });
}
