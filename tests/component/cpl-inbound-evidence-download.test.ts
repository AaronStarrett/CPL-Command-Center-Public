import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadInboundEvidence } from "../../apps/web/app/workspace/integration-evidence-download";
const id = "10000000-0000-4000-8000-000000000001",
  org = "20000000-0000-4000-8000-000000000001";
const bytes = new TextEncoder().encode("<script>PRIVATE_UNTRUSTED_SOURCE</script>");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const input = { receiptId: id, bytes: bytes.byteLength, sha256 };
function setup(body = bytes, overrides: Record<string, string> = {}, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(input.bytes),
        "X-CPL-Content-SHA256": sha256,
        ...overrides,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", webcrypto);
  const create = vi.fn().mockReturnValue("blob:inert-evidence"),
    revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const clicked: { filename: string; url: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ filename: this.download, url: this.href });
  });
  return { fetcher, create, revoke, clicked };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("inert original evidence download", () => {
  it("accepts the full 4 MiB Gmail original and rejects one byte beyond it before fetching", async () => {
    const full = new Uint8Array(4_194_304).fill(65);
    const hash = createHash("sha256").update(full).digest("hex");
    const { fetcher, clicked } = setup(full, {
      "Content-Length": String(full.byteLength),
      "X-CPL-Content-SHA256": hash,
    });
    await downloadInboundEvidence({ receiptId: id, bytes: full.byteLength, sha256: hash }, org);
    expect(clicked).toHaveLength(1);
    fetcher.mockClear();
    await expect(
      downloadInboundEvidence({ receiptId: id, bytes: full.byteLength + 1, sha256: hash }, org),
    ).rejects.toThrow("metadata is unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends the server comparison company header and saves only hash-verified inert bytes", async () => {
    const { fetcher, create, revoke, clicked } = setup();
    vi.useFakeTimers();
    await downloadInboundEvidence(input, org);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/cpl-integrations/receipts/${id}/evidence`,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "X-CPL-Organization": org },
      }),
    );
    expect(create.mock.calls[0]?.[0]).toHaveProperty("type", "application/octet-stream");
    expect(clicked).toEqual([{ filename: `cpl-source-${id}.bin`, url: "blob:inert-evidence" }]);
    expect(document.body).not.toHaveTextContent("PRIVATE_UNTRUSTED_SOURCE");
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledWith("blob:inert-evidence");
  });
  it("refuses changed bytes even when response metadata repeats the expected hash", async () => {
    const corrupt = Uint8Array.from(bytes);
    corrupt[0] ^= 1;
    const { create, clicked } = setup(corrupt);
    await expect(downloadInboundEvidence(input, org)).rejects.toThrow("hash check");
    expect(create).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });
  it("refuses active content instead of navigating to it", async () => {
    const { create } = setup(bytes, { "Content-Type": "text/html" });
    await expect(downloadInboundEvidence(input, org)).rejects.toThrow("saved metadata");
    expect(create).not.toHaveBeenCalled();
  });
  it("refuses an oversized response stream before creating a file", async () => {
    const { create } = setup(new Uint8Array(bytes.byteLength + 1));
    await expect(downloadInboundEvidence(input, org)).rejects.toThrow("exceeded");
    expect(create).not.toHaveBeenCalled();
  });
  it("does not download after authorization refusal", async () => {
    const { create } = setup(new Uint8Array(), {}, 403);
    await expect(downloadInboundEvidence(input, org)).rejects.toThrow("current company or access");
    expect(create).not.toHaveBeenCalled();
  });
});
