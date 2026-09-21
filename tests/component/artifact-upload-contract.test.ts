import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_MULTIPART_OVERHEAD_BYTES,
  isArtifactUploadFile,
  parseArtifactUploadForm,
  validateArtifactUploadTransport,
} from "../../apps/web/lib/artifact-upload-contract";

const conversationId = "10000000-0000-4000-8000-000000000099";
const repositoryRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function crossRealmFileLike() {
  return {
    async arrayBuffer() {
      return new TextEncoder().encode("synthetic upload").buffer;
    },
    name: "synthetic.txt",
    size: 16,
    type: "text/plain",
  };
}

describe("artifact upload route form contract", () => {
  it("accepts a cross-realm-safe File-like object without relying on instanceof", () => {
    const candidate = crossRealmFileLike();
    expect(candidate).not.toBeInstanceOf(File);
    expect(isArtifactUploadFile(candidate)).toBe(true);

    const formData = new FormData();
    const platformFile = new File(["synthetic upload"], candidate.name, {
      type: candidate.type,
    });
    if (!("arrayBuffer" in platformFile)) {
      Object.defineProperty(platformFile, "arrayBuffer", {
        value: candidate.arrayBuffer,
      });
    }
    formData.append("file", platformFile);
    formData.append("conversationId", conversationId.toUpperCase());
    expect(parseArtifactUploadForm(formData)).toMatchObject({
      conversationId,
      file: expect.objectContaining({ name: "synthetic.txt", type: "text/plain" }),
    });
  });

  it("rejects missing ownership association, duplicates, and arbitrary fields", () => {
    const missingConversation = new FormData();
    missingConversation.append(
      "file",
      new File(["synthetic"], "synthetic.txt", { type: "text/plain" }),
    );
    expect(parseArtifactUploadForm(missingConversation)).toBeNull();

    const extraField = new FormData();
    extraField.append("file", new File(["synthetic"], "synthetic.txt", { type: "text/plain" }));
    extraField.append("conversationId", conversationId);
    extraField.append("ownerId", conversationId);
    expect(parseArtifactUploadForm(extraField)).toBeNull();
  });

  it("rejects missing, invalid, and oversized transports before multipart parsing", () => {
    const maxUploadBytes = 10_000_000;
    expect(validateArtifactUploadTransport(null, maxUploadBytes)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(validateArtifactUploadTransport("   ", maxUploadBytes)).toEqual({
      ok: false,
      reason: "missing",
    });
    for (const invalid of ["0", "-1", "NaN", "1.5", "Infinity", "9007199254740992"]) {
      expect(validateArtifactUploadTransport(invalid, maxUploadBytes)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(
      validateArtifactUploadTransport(
        String(maxUploadBytes + ARTIFACT_MULTIPART_OVERHEAD_BYTES + 1),
        maxUploadBytes,
      ),
    ).toEqual({ ok: false, reason: "too_large" });
    expect(
      validateArtifactUploadTransport(
        String(maxUploadBytes + ARTIFACT_MULTIPART_OVERHEAD_BYTES),
        maxUploadBytes,
      ),
    ).toEqual({
      contentLength: maxUploadBytes + ARTIFACT_MULTIPART_OVERHEAD_BYTES,
      ok: true,
    });

    const routeSource = source("apps/web/app/api/artifacts/upload/route.ts");
    expect(routeSource.indexOf("validateArtifactUploadTransport(")).toBeLessThan(
      routeSource.indexOf("request.formData()"),
    );
  });

  it("attributes restricted owner uploads to the application instead of a provider", () => {
    const persistenceSource = source("apps/web/lib/artifact-upload-persistence.ts");
    expect(persistenceSource).toContain('provider: "application"');
    expect(persistenceSource).not.toContain('provider: "demo"');
    expect(persistenceSource).toContain('origin: "restricted_upload"');
  });
});
