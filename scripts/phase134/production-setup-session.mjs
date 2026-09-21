import { createServer } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_SETUP_BODY_BYTES = 65_536;
const DEFAULT_SETUP_TTL_MS = 10 * 60_000;

function constantTimeTokenEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""), "utf8");
  const rightBytes = Buffer.from(String(right ?? ""), "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function createOneTimeSetupAuthorization(options = {}) {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SETUP_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60_000) {
    throw new Error("The setup authorization lifetime must be from one through thirty minutes.");
  }
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("The setup authorization token is invalid.");
  }
  let consumed = false;
  let activeRequest = false;
  return Object.freeze({
    expiresAt: new Date(now + ttlMs).toISOString(),
    token,
    authorize(candidate, at = Date.now()) {
      return (
        !consumed && !activeRequest && at < now + ttlMs && constantTimeTokenEqual(token, candidate)
      );
    },
    begin(candidate, at = Date.now()) {
      if (!this.authorize(candidate, at)) return false;
      activeRequest = true;
      return true;
    },
    finish(success) {
      if (!activeRequest) return;
      activeRequest = false;
      if (success) consumed = true;
    },
    get consumed() {
      return consumed;
    },
  });
}

export function validateSetupSubmission(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Setup input is invalid.");
  }
  const allowed = new Set([
    "databaseChoice",
    "databaseUrl",
    "tlsMode",
    "postgresToolsDirectory",
    "ownerUsername",
    "password",
    "passwordConfirmation",
    "webPort",
    "httpsPort",
    "workerHealthPort",
    "controlPort",
    "setupPort",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Setup input contains unknown fields.");
  }
  if (!["existing", "managed", "dedicated-local"].includes(value.databaseChoice)) {
    throw new Error("Select a supported PostgreSQL setup choice.");
  }
  if (value.databaseChoice === "dedicated-local") {
    return Object.freeze({ databaseChoice: "dedicated-local" });
  }
  if (
    typeof value.databaseUrl !== "string" ||
    value.databaseUrl.length > 8_192 ||
    !/^postgres(?:ql)?:\/\/[^\s]+$/u.test(value.databaseUrl)
  ) {
    throw new Error("A PostgreSQL connection URL is required.");
  }
  if (!["prefer", "require", "verify-full"].includes(value.tlsMode)) {
    throw new Error("Select a supported PostgreSQL TLS mode.");
  }
  let databaseHostname;
  try {
    databaseHostname = new URL(value.databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("A PostgreSQL connection URL is required.");
  }
  const loopbackDatabase =
    databaseHostname === "localhost" ||
    databaseHostname === "127.0.0.1" ||
    databaseHostname === "[::1]";
  if (value.tlsMode === "prefer" && (value.databaseChoice === "managed" || !loopbackDatabase)) {
    throw new Error("Managed and non-loopback PostgreSQL connections require TLS.");
  }
  if (
    value.postgresToolsDirectory !== "" &&
    value.postgresToolsDirectory !== null &&
    value.postgresToolsDirectory !== undefined &&
    (typeof value.postgresToolsDirectory !== "string" ||
      value.postgresToolsDirectory.length > 1_024)
  ) {
    throw new Error("The PostgreSQL tools directory is invalid.");
  }
  if (
    typeof value.ownerUsername !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._-]{2,63}$/u.test(value.ownerUsername)
  ) {
    throw new Error("The Local Owner username is invalid.");
  }
  if (
    typeof value.password !== "string" ||
    Buffer.byteLength(value.password, "utf8") > 1_024 ||
    Array.from(value.password).length < 14 ||
    value.password !== value.passwordConfirmation
  ) {
    throw new Error("The Local Owner passphrase is invalid or does not match.");
  }
  const portFields = ["webPort", "httpsPort", "workerHealthPort", "controlPort", "setupPort"];
  const suppliedPorts = portFields.some((key) => value[key] !== undefined);
  let ports;
  if (suppliedPorts) {
    const values = portFields.map((key) => Number(value[key]));
    if (
      values.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535) ||
      new Set(values).size !== values.length
    ) {
      throw new Error("All production ports must be valid and distinct.");
    }
    ports = {
      web: values[0],
      https: values[1],
      workerHealth: values[2],
      control: values[3],
      setup: values[4],
    };
  }
  return Object.freeze({
    databaseChoice: value.databaseChoice,
    databaseUrl: value.databaseUrl,
    tlsMode: value.tlsMode,
    postgresToolsDirectory:
      typeof value.postgresToolsDirectory === "string" && value.postgresToolsDirectory.trim()
        ? value.postgresToolsDirectory.trim()
        : null,
    ownerUsername: value.ownerUsername.normalize("NFKC").trim().toLowerCase(),
    password: value.password,
    ...(ports ? { ports: Object.freeze(ports) } : {}),
  });
}

function setupHtml(defaults = {}) {
  const ports = defaults.ports ?? {
    web: 3210,
    https: 3443,
    workerHealth: 3211,
    control: 3212,
    setup: 3444,
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Configure BEA Local Live Production</title>
<style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;color:#172033;background:#f5f7fb}main{background:white;padding:2rem;border-radius:18px;box-shadow:0 8px 40px #14213d22}label{display:block;margin:1rem 0}.hint{color:#526070}.secret{font-family:ui-monospace,monospace;word-break:break-all;background:#eef3ff;padding:1rem;border-radius:10px}button{padding:.7rem 1rem}input,select{display:block;width:100%;box-sizing:border-box;padding:.65rem;margin-top:.35rem}#status{white-space:pre-wrap}</style></head>
<body><main><h1>BEA Local Live Production</h1><p class="hint">This one-time setup page is available only on loopback over trusted HTTPS. Secrets are sent only to this local setup process and are not retained by the page.</p>
<form id="setup"><label>PostgreSQL choice<select name="databaseChoice"><option value="existing">Existing PostgreSQL</option><option value="managed">Managed PostgreSQL</option><option value="dedicated-local">Dedicated local PostgreSQL (requires separate Owner approval)</option></select></label>
<label>PostgreSQL URL<input name="databaseUrl" type="password" autocomplete="off" spellcheck="false"></label>
<label>TLS mode<select name="tlsMode"><option value="prefer">Prefer (loopback existing)</option><option value="require">Require</option><option value="verify-full">Verify full</option></select></label>
<label>PostgreSQL tools directory (optional)<input name="postgresToolsDirectory" autocomplete="off" spellcheck="false"></label>
<fieldset><legend>Production ports</legend><label>Internal web<input name="webPort" type="number" min="1" max="65535" value="${String(ports.web)}"></label><label>HTTPS owner endpoint<input name="httpsPort" type="number" min="1" max="65535" value="${String(ports.https)}"></label><label>Worker health<input name="workerHealthPort" type="number" min="1" max="65535" value="${String(ports.workerHealth)}"></label><label>Control<input name="controlPort" type="number" min="1" max="65535" value="${String(ports.control)}"></label><label>Setup<input name="setupPort" type="number" min="1" max="65535" value="${String(ports.setup)}"></label></fieldset>
<label>Local Owner username<input name="ownerUsername" value="owner" autocomplete="username"></label>
<label>Passphrase (14+ characters)<input name="password" type="password" autocomplete="new-password"></label>
<label>Confirm passphrase<input name="passwordConfirmation" type="password" autocomplete="new-password"></label>
  <button type="submit">Configure Local Live</button></form><p id="status" role="status"></p><section id="recovery" hidden><h2>Copy the recovery code now</h2><p>Store it in a password manager, then acknowledge receipt. The setup process keeps it only in memory until acknowledgement or expiry.</p><div class="secret" id="recoveryCode"></div><button id="acknowledge" type="button">I saved the recovery code</button></section></main>
  <script>'use strict';const token=location.hash.startsWith('#authorization=')?decodeURIComponent(location.hash.slice(15)):'';const form=document.getElementById('setup'),status=document.getElementById('status'),recovery=document.getElementById('recovery'),recoveryCode=document.getElementById('recoveryCode'),acknowledge=document.getElementById('acknowledge');const request=async(path,body={})=>{const response=await fetch(path,{method:'POST',credentials:'omit',cache:'no-store',headers:{'authorization':'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.message||'Setup could not be completed.');return result;};const showResult=result=>{form.hidden=true;if(typeof result.recoveryCode==='string'&&result.recoveryCode){recoveryCode.textContent=result.recoveryCode;recovery.hidden=false;status.textContent='The Local Owner recovery code is ready. Save it now; acknowledgement performs final readiness verification.';}else{history.replaceState(null,'',location.pathname);status.textContent='Configuration was already complete and has been revalidated. Close this page, then run BEA-Doctor.cmd --deep.';}};form.addEventListener('submit',async event=>{event.preventDefault();status.textContent='Preparing migrations, build, protected paths, and the Local Owner identity…';try{showResult(await request('/setup/apply',Object.fromEntries(new FormData(form).entries())));}catch(error){status.textContent=error instanceof Error?error.message:'Setup could not be completed.';}});acknowledge.addEventListener('click',async()=>{try{await request('/setup/acknowledge');recoveryCode.textContent='';recovery.hidden=true;history.replaceState(null,'',location.pathname);status.textContent='Recovery code receipt acknowledged and readiness finalized. Close this page, then run BEA-Doctor.cmd --deep.';}catch(error){status.textContent=error instanceof Error?error.message:'Acknowledgement could not be completed.';}});if(token){request('/setup/result').then(showResult).catch(()=>undefined);}else{status.textContent='The one-time setup authorization is missing.';form.hidden=true;}</script></body></html>`;
}

function safeJson(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(payload.byteLength),
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SETUP_BODY_BYTES) throw new Error("Setup input is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Setup input is invalid JSON.");
  }
}

export function createPendingSetupCompletion(result) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("The setup operation returned an invalid result.");
  }
  const recoveryCode =
    typeof result.recoveryCode === "string" && result.recoveryCode ? result.recoveryCode : null;
  let finalized = false;
  return Object.freeze({
    acknowledgementRequired: recoveryCode !== null,
    publicResult: Object.freeze({
      recoveryCode,
      acknowledgementRequired: recoveryCode !== null,
    }),
    async finalize() {
      if (finalized) return;
      if (typeof result.finalize === "function") await result.finalize();
      finalized = true;
    },
    get finalized() {
      return finalized;
    },
  });
}

export async function startProductionSetupSession(options) {
  if (!Buffer.isBuffer(options.pfx) || typeof options.passphrase !== "string") {
    throw new Error("Trusted Local Live HTTPS material is required.");
  }
  if (typeof options.applySetup !== "function") throw new Error("A setup operation is required.");
  const hostname = options.hostname ?? "bea.localhost";
  const port = options.port;
  if (!hostname.endsWith(".localhost") || !Number.isSafeInteger(port)) {
    throw new Error("The setup listener requires a loopback-safe hostname and explicit port.");
  }
  const expectedHost = `${hostname}:${String(port)}`.toLowerCase();
  const expectedOrigin = `https://${expectedHost}`;
  const authorization = createOneTimeSetupAuthorization(options);
  let completed = false;
  let pendingResult = null;
  let pendingCompletion = null;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const server = (options.createServer ?? createServer)(
    { pfx: options.pfx, passphrase: options.passphrase, minVersion: "TLSv1.2" },
    async (request, response) => {
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
      response.setHeader("strict-transport-security", "max-age=31536000");
      if (String(request.headers.host ?? "").toLowerCase() !== expectedHost) {
        safeJson(response, 421, { code: "UNEXPECTED_HOST", message: "Unexpected setup host." });
        return;
      }
      const url = new URL(request.url ?? "/", expectedOrigin);
      if (request.method === "GET" && url.pathname === "/setup" && !url.search) {
        const body = Buffer.from(setupHtml(options.defaults), "utf8");
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": String(body.byteLength),
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
        return;
      }
      const setupPostRoutes = new Set(["/setup/apply", "/setup/result", "/setup/acknowledge"]);
      if (request.method !== "POST" || !setupPostRoutes.has(url.pathname) || url.search) {
        safeJson(response, 404, { code: "NOT_FOUND", message: "Setup route not found." });
        return;
      }
      if (
        request.headers.origin !== expectedOrigin ||
        request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        safeJson(response, 403, {
          code: "SETUP_ORIGIN_DENIED",
          message: "Setup origin was denied.",
        });
        return;
      }
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(
        String(request.headers.authorization ?? ""),
      );
      if (!bearer || !authorization.begin(bearer[1])) {
        safeJson(response, 401, {
          code: "SETUP_AUTHORIZATION_DENIED",
          message: "The setup authorization is invalid, expired, used, or busy.",
        });
        return;
      }
      let succeeded = false;
      try {
        if (url.pathname === "/setup/result") {
          safeJson(
            response,
            pendingResult ? 200 : 404,
            pendingResult
              ? { code: "BEA_LOCAL_LIVE_PENDING_ACKNOWLEDGEMENT", ...pendingResult }
              : {
                  code: "NO_PENDING_RESULT",
                  message: "No setup result is awaiting acknowledgement.",
                },
          );
          return;
        }
        if (url.pathname === "/setup/acknowledge") {
          if (!pendingResult || !pendingCompletion) {
            safeJson(response, 409, {
              code: "NO_PENDING_RESULT",
              message: "No setup result is awaiting acknowledgement.",
            });
            return;
          }
          await pendingCompletion.finalize();
          response.once("finish", () => {
            pendingResult = null;
            pendingCompletion = null;
            authorization.finish(true);
            completed = true;
            resolveCompletion({ outcome: "PASS" });
            setTimeout(() => server.close(), options.successCloseDelayMs ?? 30_000).unref();
          });
          succeeded = true;
          safeJson(response, 200, { code: "BEA_RECOVERY_CODE_ACKNOWLEDGED" });
          return;
        }
        if (pendingResult) {
          safeJson(response, 200, {
            code: "BEA_LOCAL_LIVE_PENDING_ACKNOWLEDGEMENT",
            ...pendingResult,
          });
          return;
        }
        const submission = validateSetupSubmission(await readJsonBody(request));
        if (submission.databaseChoice === "dedicated-local") {
          safeJson(response, 409, {
            code: "OWNER_PREREQUISITE_REQUIRED",
            message:
              "A dedicated PostgreSQL installation requires a separate explicit Owner approval. No installation was started.",
          });
          return;
        }
        const result = await options.applySetup(submission);
        const application = createPendingSetupCompletion(result);
        if (application.acknowledgementRequired) {
          pendingCompletion = application;
          pendingResult = application.publicResult;
          safeJson(response, 200, { code: "BEA_LOCAL_LIVE_RECOVERY_READY", ...pendingResult });
        } else {
          await application.finalize();
          response.once("finish", () => {
            authorization.finish(true);
            completed = true;
            resolveCompletion({ outcome: "PASS" });
            setTimeout(() => server.close(), options.successCloseDelayMs ?? 30_000).unref();
          });
          succeeded = true;
          safeJson(response, 200, { code: "BEA_LOCAL_LIVE_CONFIGURED", recoveryCode: null });
        }
      } catch (error) {
        safeJson(response, 400, {
          code: "SETUP_FAILED",
          message: `Setup failed closed (${error instanceof Error ? error.name : "UnknownError"}). Correct the input and try again.`,
        });
      } finally {
        if (!succeeded) authorization.finish(false);
      }
    },
  );
  server.maxHeadersCount = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 600_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const expiryTimer = setTimeout(() => server.close(), options.ttlMs ?? DEFAULT_SETUP_TTL_MS);
  expiryTimer.unref();
  server.once("close", () => {
    if (!completed) resolveCompletion({ outcome: "EXPIRED" });
  });
  return Object.freeze({
    authorization,
    completion,
    url: `${expectedOrigin}/setup#authorization=${encodeURIComponent(authorization.token)}`,
    close: () =>
      new Promise((resolve, reject) => {
        clearTimeout(expiryTimer);
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
}
