import { createHash, createHmac, randomBytes } from "node:crypto";

/** Local synthetic sender. Pass exact UTF-8 request JSON on stdin. Supply the
 * source credential through this process's environment, never argv or a URL.
 * This example cannot target a remote host and never prints credentials/body. */
async function main() {
  const url = new URL(process.env.CPL_INBOUND_URL ?? "");
  const keyId = process.env.CPL_SOURCE_KEY_ID ?? "";
  const generation = Number(process.env.CPL_SOURCE_KEY_GENERATION);
  const encodedKey = process.env.CPL_SOURCE_SECRET ?? "";
  const match = /^\/api\/cpl-inbound\/sources\/([A-Za-z0-9_-]{24,80})$/u.exec(url.pathname);
  if (
    url.origin !== "http://127.0.0.1:3400" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !/^[A-Za-z0-9_-]{16,80}$/u.test(keyId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(encodedKey)
  )
    throw new Error("configuration");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65_536) throw new Error("size");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (
    !parsed ||
    typeof parsed.eventId !== "string" ||
    !Number.isInteger(parsed.configurationVersion)
  )
    throw new Error("payload");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(32).toString("base64url");
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const material = JSON.stringify([
    "cpl-inbound-v1",
    "POST",
    match[1],
    keyId,
    generation,
    timestamp,
    nonce,
    contentHash,
  ]);
  const key = Buffer.from(encodedKey, "base64url");
  const signature = createHmac("sha256", key).update(material, "utf8").digest("base64url");
  key.fill(0);
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      origin: url.origin,
      "x-cpl-source-key": keyId,
      "x-cpl-timestamp": timestamp,
      "x-cpl-nonce": nonce,
      "x-cpl-signature": signature,
    },
    body: raw,
  });
  const body = await response.json().catch(() => ({}));
  const reference =
    typeof body.reference === "string" && /^INQ-[A-F0-9]{24}$/u.test(body.reference)
      ? body.reference
      : undefined;
  console.log(
    JSON.stringify({
      httpStatus: response.status,
      accepted: response.status === 202,
      ...(reference ? { reference } : {}),
    }),
  );
  if (response.status !== 202) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "Local signed inquiry was not accepted. Check local configuration, payload and source state; no sensitive details were logged.",
  );
  process.exitCode = 1;
});
