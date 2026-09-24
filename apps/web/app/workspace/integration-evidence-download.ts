export type InboundEvidenceDownload = { receiptId: string; sha256: string; bytes: number };

/** Fetch only the selected company's inert original. Source-provided filenames,
 * markup and URLs are never used for navigation or rendering. */
export async function downloadInboundEvidence(
  input: InboundEvidenceDownload,
  organizationId: string,
): Promise<void> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
  if (
    !uuid.test(input.receiptId) ||
    !uuid.test(organizationId) ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > 4_194_304
  )
    throw new Error("The original evidence metadata is unavailable. Reload the source receipt.");
  const response = await fetch(`/api/cpl-integrations/receipts/${input.receiptId}/evidence`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-CPL-Organization": organizationId },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      "The original evidence is unavailable for your current company or access. Reload the source receipt.",
    );
  if (
    response.headers.get("content-type") !== "application/octet-stream" ||
    response.headers.get("content-length") !== String(input.bytes) ||
    response.headers.get("X-CPL-Content-SHA256") !== input.sha256 ||
    !response.body
  )
    throw new Error(
      "The original evidence response did not match its saved metadata. No file was downloaded.",
    );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > input.bytes)
        throw new Error("The original evidence exceeded its saved size. No file was downloaded.");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  if (length !== input.bytes)
    throw new Error("The original evidence was incomplete. No file was downloaded.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== input.sha256)
    throw new Error("The original evidence failed its saved hash check. No file was downloaded.");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `cpl-source-${input.receiptId}.bin`;
    link.rel = "noopener noreferrer";
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
