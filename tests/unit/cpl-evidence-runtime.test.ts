import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  cplEvidenceStorage,
  cplImageUpload,
  CPL_UPLOAD_MAXIMUM_BYTES,
} from "../../apps/web/lib/cpl-evidence-runtime";
afterEach(() => vi.unstubAllEnvs());
function upload(bytes: Uint8Array = new Uint8Array([1, 2]), headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3400/api/cpl-field/projects/example/visits/example/photos", {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-cpl-filename": "Fictional%20photo.png",
      "x-cpl-idempotency-key": "stable-file-key",
      ...headers,
    },
    body: bytes.buffer as ArrayBuffer,
  });
}
describe("private evidence runtime boundary", () => {
  it("cannot activate local storage using request input or a production environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CPL_LOCAL_DEVELOPMENT_AUTH", undefined);
    await expect(
      cplEvidenceStorage(new Request("https://example.invalid/?CPL_LOCAL_DEVELOPMENT_AUTH=true")),
    ).rejects.toMatchObject({ code: "CPL_EVIDENCE_STORAGE_UNAVAILABLE" });
    vi.stubEnv("CPL_LOCAL_DEVELOPMENT_AUTH", "true");
    await expect(cplEvidenceStorage(new Request("http://127.0.0.1:3400"))).rejects.toBeDefined();
  });
  it("hashes a bounded raw body while preserving the exact bytes", async () => {
    const value = await cplImageUpload(upload());
    expect(value.bytes).toEqual(new Uint8Array([1, 2]));
    expect(value.filename).toBe("Fictional photo.png");
    expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.idempotencyKey).toBe("stable-file-key");
  });
  it.each([
    { "content-type": "image/svg+xml" },
    { "x-cpl-filename": "..%2Fprivate.png" },
    { "x-cpl-filename": "%00.png" },
    { "x-cpl-filename": "%" },
    { "x-cpl-idempotency-key": "x" },
    { "content-length": String(CPL_UPLOAD_MAXIMUM_BYTES + 1) },
  ])("refuses unsafe headers before buffering", async (headers) => {
    await expect(cplImageUpload(upload(undefined, headers))).rejects.toBeDefined();
  });
  it("enforces its limit even without a trusted length header", async () => {
    const bytes = new Uint8Array(CPL_UPLOAD_MAXIMUM_BYTES + 1);
    await expect(cplImageUpload(upload(bytes))).rejects.toMatchObject({
      code: "CPL_IMAGE_LIMIT_EXCEEDED",
    });
    await expect(cplImageUpload(upload(new Uint8Array()))).rejects.toMatchObject({
      code: "CPL_IMAGE_INVALID_UPLOAD",
    });
  });
});
