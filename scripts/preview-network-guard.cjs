"use strict";

const guardStateKey = Symbol.for("bea.preview.loopback-network-guard");

function normalizedLoopbackHost(value) {
  if (value === undefined || value === null || value === "") return "127.0.0.1";
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "127.0.0.1") return "127.0.0.1";
  if (normalized === "::1") return "::1";
  return undefined;
}

function exactPreviewEnvironment(environment) {
  const expected = {
    APP_BASE_URL: "http://127.0.0.1:3100",
    APP_MODE: "demo",
    BEA_AUTH_PROVIDER: "demo",
    BEA_DEPLOYMENT_PROFILE: "demo",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_PREVIEW_AUTHORITY: "Start-BEA-Preview.cmd",
    BEA_PREVIEW_MODE: "true",
    BEA_PREVIEW_NETWORK_GUARD: "loopback-only",
    BEA_PRODUCTION_SECRET_PATH: "",
    BEA_RUNTIME_MODE: "development",
    DATABASE_DRIVER: "pglite",
    DATABASE_URL: "",
    OPENAI_API_KEY: "",
    SESSION_SECRET: "",
  };
  return Object.entries(expected).every(([key, value]) => environment[key] === value);
}

function blockedConnectionError() {
  const error = new Error("BEA Preview permits loopback TCP/TLS connections only.");
  error.code = "BEA_PREVIEW_NON_LOOPBACK_NETWORK_BLOCKED";
  return error;
}

function normalizeConnectionArguments(arguments_, approvedSockets) {
  const normalized = [...arguments_];
  const first = normalized[0];
  // node:net normalizes public connect arguments to [options, callback] and then
  // passes that array as the first argument to Socket.prototype.connect. Preserve
  // its private normalized-arguments symbol when cloning; losing it makes Node
  // reinterpret the nested array as public input and discard the port.
  if (Array.isArray(first)) {
    const nested = normalizeConnectionArguments(first, approvedSockets);
    for (const symbol of Object.getOwnPropertySymbols(first)) {
      const descriptor = Object.getOwnPropertyDescriptor(first, symbol);
      if (descriptor) Object.defineProperty(nested, symbol, descriptor);
    }
    normalized[0] = nested;
    return normalized;
  }
  if (typeof first === "string") return normalized;
  if (typeof first === "number") {
    const second = normalized[1];
    if (typeof second === "string") {
      const host = normalizedLoopbackHost(second);
      if (!host) throw blockedConnectionError();
      normalized[1] = host;
      return normalized;
    }
    if (second && typeof second === "object") {
      const host = normalizedLoopbackHost(second.host ?? second.hostname);
      if (!host) throw blockedConnectionError();
      const options = { ...second, host, hostname: host };
      delete options.lookup;
      normalized[1] = options;
      return normalized;
    }
    normalized.splice(1, 0, "127.0.0.1");
    return normalized;
  }
  if (!first || typeof first !== "object") throw blockedConnectionError();
  if (first.socket !== undefined) {
    if (!approvedSockets.has(first.socket)) throw blockedConnectionError();
    return normalized;
  }
  if (typeof first.path === "string" && first.port === undefined) return normalized;
  const host = normalizedLoopbackHost(first.host ?? first.hostname);
  if (!host) throw blockedConnectionError();
  const options = { ...first, host, hostname: host };
  delete options.lookup;
  normalized[0] = options;
  return normalized;
}

function installGuardedMethod(target, name, approvedSockets) {
  const original = target[name];
  if (typeof original !== "function") throw new Error("Preview network guard target is invalid.");
  const guarded = function guardedPreviewConnection(...arguments_) {
    const normalized = normalizeConnectionArguments(arguments_, approvedSockets);
    const socket = Reflect.apply(original, this, normalized);
    if (socket && typeof socket === "object") approvedSockets.add(socket);
    return socket;
  };
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: Object.prototype.propertyIsEnumerable.call(target, name),
    value: guarded,
    writable: false,
  });
}

function installPreviewNetworkGuard() {
  if (globalThis[guardStateKey]?.installed === true) return globalThis[guardStateKey];
  const net = require("node:net");
  const approvedSockets = new WeakSet();
  installGuardedMethod(net.Socket.prototype, "connect", approvedSockets);
  installGuardedMethod(net, "connect", approvedSockets);
  installGuardedMethod(net, "createConnection", approvedSockets);
  const tls = require("node:tls");
  installGuardedMethod(tls, "connect", approvedSockets);
  const state = Object.freeze({ installed: true });
  Object.defineProperty(globalThis, guardStateKey, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

const previewSignaled =
  process.env.BEA_PREVIEW_MODE !== undefined ||
  process.env.BEA_PREVIEW_AUTHORITY !== undefined ||
  process.env.BEA_PREVIEW_NETWORK_GUARD !== undefined;

if (previewSignaled && !exactPreviewEnvironment(process.env)) {
  const error = new Error("BEA Preview network guard received an invalid Preview environment.");
  error.code = "BEA_PREVIEW_NETWORK_GUARD_ENVIRONMENT_INVALID";
  throw error;
}

const state = previewSignaled ? installPreviewNetworkGuard() : Object.freeze({ installed: false });

module.exports = Object.freeze({
  exactPreviewEnvironment,
  installed: state.installed,
  isLoopbackHost: (value) => normalizedLoopbackHost(value) !== undefined,
});
