import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  LOCAL_CACHE_ROOT,
  LOCAL_PORT,
  LOCAL_URL,
  VERIFIED_NODE,
  createControlServer,
  createSafeEnvironment,
  ownsProcessEvidence,
  requestControl,
  runtimePaths,
  warmSetupPage,
} from "../../scripts/cpl-local.mjs";

const root = "D:\\Cyber Pirate Labs\\03_ENGINEERING\\Repositories\\CPL-Command-Center";

test("development launch strips inherited secrets, demo switches, loaders, and external database settings", () => {
  const environment = createSafeEnvironment(root, {
    Path: "D:\\PortableNode;C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    OPENAI_API_KEY: "synthetic-key",
    DATABASE_URL: "postgres://synthetic.invalid/db",
    SESSION_SECRET: "synthetic-session",
    NODE_OPTIONS: "--import=untrusted-loader",
    APP_MODE: "demo",
    DEMO_AUTH_ENABLED: "true",
    CPL_ALLOW_OPERATIONAL_RUNTIME: "true",
    BEA_OWNER_EVALUATION_PUBLIC_ORIGIN: "https://synthetic.invalid",
    HTTP_PROXY: "https://synthetic.invalid",
    CPL_LOCAL_DEVELOPMENT_AUTH: "true",
    CPL_LOCAL_DATABASE_URL: "postgres://untrusted.invalid/db",
    CPL_LOCAL_SESSION_SECRET: "untrusted",
    CPL_HOSTED_ENABLED: "true",
    PATH: "C:\\UntrustedNode",
  });
  assert.equal(environment.OPENAI_API_KEY, "");
  assert.equal(environment.DATABASE_URL, "");
  assert.equal(environment.SESSION_SECRET, "");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.CPL_ALLOW_OPERATIONAL_RUNTIME, undefined);
  assert.equal(environment.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN, undefined);
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.CPL_LOCAL_DEVELOPMENT_AUTH, undefined);
  assert.equal(environment.CPL_LOCAL_DATABASE_URL, undefined);
  assert.equal(environment.CPL_LOCAL_SESSION_SECRET, undefined);
  assert.equal(environment.CPL_HOSTED_ENABLED, undefined);
  assert.equal(environment.PATH, undefined);
  assert.ok(environment.Path.startsWith(path.dirname(VERIFIED_NODE)));
  assert.equal(environment.APP_MODE, "production");
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.DEMO_AUTH_ENABLED, "false");
  assert.equal(environment.BEA_DISABLE_ENV_FILE, "true");
  assert.equal(environment.APP_BASE_URL, "http://127.0.0.1:3400");
  assert.equal(LOCAL_PORT, 3400);
  assert.equal(LOCAL_URL, "http://127.0.0.1:3400/workspace");
});

test("setup readiness waits for complete HTTP content after the listening socket is available", async () => {
  let completeResponse;
  const phases = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.write("<title>Workspace setup | CPL Command Center</title>");
    completeResponse = () => response.end("<main>Workspace setup</main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    let ready = false;
    const warmup = warmSetupPage({
      url: "http://127.0.0.1:" + server.address().port + "/setup",
      timeoutMs: 2000,
      progressMs: 10,
      onProgress: (progress) => phases.push(progress.state),
    }).then((result) => {
      ready = true;
      return result;
    });
    while (!completeResponse) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ready, false);
    assert.ok(phases.includes("STARTING"));
    assert.ok(phases.includes("COMPILING"));
    completeResponse();
    assert.equal((await warmup).state, "READY");
    assert.equal(phases.at(-1), "READY");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("setup readiness refuses HTTP errors and unrelated successful pages", async () => {
  for (const [status, body, message] of [
    [503, "Unavailable", "SETUP_HTTP_503"],
    [200, "Unrelated local process", "SETUP_RESPONSE_NOT_RECOGNIZED"],
  ]) {
    const server = createServer((_request, response) => response.writeHead(status).end(body));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        warmSetupPage({
          url: "http://127.0.0.1:" + server.address().port + "/setup",
          timeoutMs: 2000,
        }),
        { message },
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("setup compilation has a bounded wait and never reports ready on timeout", async () => {
  const phases = [];
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      warmSetupPage({
        url: "http://127.0.0.1:" + server.address().port + "/setup",
        timeoutMs: 50,
        onProgress: (progress) => phases.push(progress.state),
      }),
      /Setup did not become ready/,
    );
    assert.equal(phases.includes("READY"), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("shutdown cancels an in-progress setup compilation", async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const warmup = warmSetupPage({
      url: "http://127.0.0.1:" + server.address().port + "/setup",
      signal: controller.signal,
      onProgress: ({ state }) => {
        if (state === "COMPILING") controller.abort();
      },
    });
    await assert.rejects(warmup, { name: "AbortError" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime caches use the requested SSD cache root while ownership state stays in the checkout", () => {
  const environment = createSafeEnvironment(root, {
    TEMP: "C:\\Unexpected",
    APPDATA: "C:\\Unexpected",
  });
  for (const name of [
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "npm_config_cache",
    "PLAYWRIGHT_BROWSERS_PATH",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    assert.ok(environment[name].startsWith(LOCAL_CACHE_ROOT + path.sep));
    assert.equal(environment[name].includes("C:\\Unexpected"), false);
  }
  const original = runtimePaths(root);
  assert.equal(LOCAL_CACHE_ROOT, "D:\\Cyber Pirate Labs\\93_TOOLS_AND_CACHE\\CPL-Command-Center");
  assert.equal(original.tooling, LOCAL_CACHE_ROOT);
  assert.ok(original.stateDirectory.startsWith(root + path.sep));
  assert.ok(original.stateFile.startsWith(original.stateDirectory + path.sep));
  assert.equal(original.pipe, runtimePaths(root).pipe);
  assert.notEqual(original.pipe, runtimePaths(root + "-other").pipe);
});

test("process termination requires exact child, parent, executable, and quoted repository script", () => {
  const expected = {
    pid: 1234,
    parentPid: 99,
    executable: "D:\\Node\\node.exe",
    script: root + "\\scripts\\next-no-env.mjs",
  };
  const evidence = {
    ProcessId: 1234,
    ParentProcessId: 99,
    ExecutablePath: expected.executable,
    CommandLine:
      '"' +
      expected.executable +
      '" "' +
      expected.script +
      '" dev --webpack --hostname 127.0.0.1 --port 3400',
  };
  assert.equal(ownsProcessEvidence(evidence, expected), true);
  for (const changed of [
    { ProcessId: 4321 },
    { ParentProcessId: 100 },
    { ExecutablePath: "D:\\Other\\node.exe" },
    { CommandLine: '"node.exe" "' + expected.script + '.other"' },
    { CommandLine: "node.exe unrelated-script.mjs" },
  ])
    assert.equal(ownsProcessEvidence({ ...evidence, ...changed }, expected), false);
  assert.equal(ownsProcessEvidence(null, expected), false);
});

test("named-pipe control exposes status without token and refuses unauthenticated shutdown", async () => {
  const pipe = "\\\\.\\pipe\\cpl-local-test-" + process.pid + "-" + randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  let stopCalls = 0;
  const control = createControlServer({
    pipe,
    token,
    status: () => ({ root, mode: "provisioning-only" }),
    stop: async () => {
      stopCalls++;
    },
  });
  await control.listen();
  try {
    const status = await requestControl(pipe, { action: "status" });
    assert.equal(status.ok, true);
    assert.equal(status.mode, "provisioning-only");
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal((await requestControl(pipe, { action: "stop" })).ok, false);
    assert.equal((await requestControl(pipe, { action: "stop", token: "0".repeat(64) })).ok, false);
    assert.equal((await requestControl(pipe, { action: "kill", token, pid: 123 })).ok, false);
    assert.equal(stopCalls, 0);
    assert.deepEqual(await requestControl(pipe, { action: "stop", token }), {
      ok: true,
      stopped: true,
    });
    assert.equal(stopCalls, 1);
  } finally {
    await new Promise((resolve) => control.server.close(resolve));
  }
});

test("control reports shutdown failures without claiming a process stopped", async () => {
  const pipe =
    "\\\\.\\pipe\\cpl-local-test-fail-" + process.pid + "-" + randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  const control = createControlServer({
    pipe,
    token,
    status: () => ({}),
    stop: async () => {
      throw new Error("ownership mismatch");
    },
  });
  await control.listen();
  try {
    const result = await requestControl(pipe, { action: "stop", token });
    assert.equal(result.ok, false);
    assert.equal(result.stopped, undefined);
  } finally {
    await new Promise((resolve) => control.server.close(resolve));
  }
});
