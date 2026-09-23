// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  storage: vi.fn(),
  getVerified: vi.fn(),
  putImmutable: vi.fn(),
  validate: vi.fn(),
  prepare: vi.fn(),
  getVisitWorkspace: vi.fn(),
  listTemplates: vi.fn(),
  saveTemplate: vi.fn(),
  attachTemplate: vi.fn(),
  saveChecklist: vi.fn(),
  saveObservation: vi.fn(),
  savePhotoMetadata: vi.fn(),
  reopenVisit: vi.fn(),
  reservePhoto: vi.fn(),
  getPhotoTransfer: vi.fn(),
  getPhotoContent: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (r: unknown) => Promise<unknown>) =>
    operation({ tenants: {} }),
  requireHostedSession: stubs.session,
  requireHostedMutation: stubs.mutation,
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplFieldRepository: class {
    getVisitWorkspace = stubs.getVisitWorkspace;
    listTemplates = stubs.listTemplates;
    saveTemplate = stubs.saveTemplate;
    attachTemplate = stubs.attachTemplate;
    saveChecklist = stubs.saveChecklist;
    saveObservation = stubs.saveObservation;
    savePhotoMetadata = stubs.savePhotoMetadata;
    reopenVisit = stubs.reopenVisit;
    reservePhoto = stubs.reservePhoto;
    getPhotoTransfer = stubs.getPhotoTransfer;
    getPhotoContent = stubs.getPhotoContent;
  },
}));
vi.mock("@/lib/cpl-evidence-runtime", async (original) => ({
  ...(await original<typeof import("../../apps/web/lib/cpl-evidence-runtime")>()),
  cplEvidenceStorage: stubs.storage,
}));
vi.mock("@bea/artifacts/cpl-image", () => ({ validateCplImageOriginal: stubs.validate }));
vi.mock("@/lib/cpl-field-evidence", () => ({ prepareCplPhoto: stubs.prepare }));
import { GET, POST } from "../../apps/web/app/api/cpl-field/[...path]/route";
const organizationId = "123e4567-e89b-12d3-a456-426614174000",
  projectId = "123e4567-e89b-12d3-a456-426614174001",
  visitId = "123e4567-e89b-12d3-a456-426614174002",
  photoId = "123e4567-e89b-12d3-a456-426614174003",
  objectId = "123e4567-e89b-12d3-a456-426614174004";
const path = ["projects", projectId, "visits", visitId],
  tenant = { sessionToken: "server-session", organizationId },
  scope = { ...tenant, projectId, visitId },
  bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  reference = { organizationId, objectId, sha256: "a".repeat(64), byteLength: 8 };
const context = (parts: string[]) => ({ params: Promise.resolve({ path: parts }) });
function request(parts: string[], body?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3400/api/cpl-field/" + parts.join("/"), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": organizationId,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function upload(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3400/api/cpl-field/" + [...path, "photos"].join("/"), {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-cpl-organization": organizationId,
      "x-cpl-filename": "example.png",
      "x-cpl-idempotency-key": "stable-upload-key",
      ...headers,
    },
    body: bytes.buffer,
  });
}
describe("field evidence HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const session = {
      sessionToken: tenant.sessionToken,
      session: { selectedOrganizationId: organizationId },
    };
    stubs.session.mockResolvedValue(session);
    stubs.mutation.mockResolvedValue(session);
    stubs.storage.mockResolvedValue({
      getVerified: stubs.getVerified,
      putImmutable: stubs.putImmutable,
    });
    stubs.getVisitWorkspace.mockResolvedValue({ permissions: { canEdit: true } });
    stubs.getPhotoContent.mockResolvedValue(reference);
    stubs.getVerified.mockResolvedValue(bytes);
    stubs.validate.mockResolvedValue({
      original: {
        filename: "example.png",
        mimeType: "image/png",
        sha256: reference.sha256,
        byteLength: 8,
        bytes,
        width: 1,
        height: 1,
        exifOrientation: null,
      },
      upright: { width: 1, height: 1 },
    });
    stubs.reservePhoto.mockResolvedValue({
      photo: { id: photoId, state: "reserved" },
      original: reference,
      thumbnailObjectId: "private-thumb",
      reportObjectId: "private-report",
    });
    stubs.prepare.mockResolvedValue({ id: photoId, state: "ready" });
    stubs.saveChecklist.mockResolvedValue({ revision: 2 });
  });
  it("refuses unauthenticated reads and CSRF before file/decoder access", async () => {
    stubs.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect(
      (
        await GET(
          request([...path, "photos", photoId, "file"]),
          context([...path, "photos", photoId, "file"]),
        )
      ).status,
    ).toBe(401);
    stubs.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect((await POST(upload(), context([...path, "photos"]))).status).toBe(403);
    expect(stubs.storage).not.toHaveBeenCalled();
    expect(stubs.validate).not.toHaveBeenCalled();
    expect(stubs.reservePhoto).not.toHaveBeenCalled();
  });
  it("checks the visit permission before reading or decoding a file", async () => {
    stubs.getVisitWorkspace.mockResolvedValue({ permissions: { canEdit: false } });
    expect((await POST(upload(), context([...path, "photos"]))).status).toBe(403);
    expect(stubs.getVisitWorkspace).toHaveBeenCalledWith(scope);
    expect(stubs.storage).not.toHaveBeenCalled();
    expect(stubs.validate).not.toHaveBeenCalled();
  });
  it("persists only validated original bytes against SQL-issued references", async () => {
    const response = await POST(upload(), context([...path, "photos"]));
    expect(response.status).toBe(201);
    expect(stubs.reservePhoto).toHaveBeenCalledWith({
      ...scope,
      idempotencyKey: "stable-upload-key",
      input: {
        filename: "example.png",
        mimeType: "image/png",
        sha256: reference.sha256,
        byteLength: 8,
      },
    });
    expect(stubs.putImmutable).toHaveBeenCalledWith({ ...reference, bytes });
    expect(await response.json()).toEqual({ id: photoId, state: "ready" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("does not reserve unsafe actual content and reports recoverable derivative failure honestly", async () => {
    stubs.validate.mockRejectedValueOnce({ code: "CPL_IMAGE_DECODE_FAILED" });
    expect((await POST(upload(), context([...path, "photos"]))).status).toBe(400);
    expect(stubs.reservePhoto).not.toHaveBeenCalled();
    stubs.prepare.mockResolvedValue({
      id: photoId,
      state: "failed",
      failureCode: "CPL_PHOTO_PROCESSING_FAILED",
    });
    const response = await POST(upload(), context([...path, "photos"]));
    expect(response.status).toBe(202);
    expect((await response.json()).state).toBe("failed");
  });
  it("gets a tenant-authorized reference before any file read and returns private bytes", async () => {
    const parts = [...path, "photos", photoId, "file"],
      r = request(parts);
    const response = await GET(new Request(r.url + "?variant=thumbnail", r), context(parts));
    expect(response.status).toBe(200);
    expect(stubs.getPhotoContent).toHaveBeenCalledWith({ ...scope, photoId, kind: "thumbnail" });
    expect(stubs.getVerified).toHaveBeenCalledWith(reference);
    expect(response.headers.get("x-artifact-sha256")).toBe(reference.sha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    stubs.getPhotoContent.mockRejectedValue({ code: "CPL_RECORD_NOT_FOUND" });
    stubs.storage.mockClear();
    expect((await GET(new Request(r.url + "?variant=original", r), context(parts))).status).toBe(
      404,
    );
    expect(stubs.storage).not.toHaveBeenCalled();
  });
  it("rejects forged tenant context and storage/approval authority in JSON", async () => {
    expect(
      (await POST(upload({ "x-cpl-organization": "other" }), context([...path, "photos"]))).status,
    ).toBe(409);
    for (const forged of [
      { organizationId: "other" },
      { objectId },
      { sha256: reference.sha256 },
      { approved: true },
    ])
      expect(
        (
          await POST(
            request([...path, "checklist"], {
              expectedRevision: 1,
              idempotencyKey: "checklist-retry-key",
              answers: [],
              ...forged,
            }),
            context([...path, "checklist"]),
          )
        ).status,
      ).toBe(400);
    expect(stubs.saveChecklist).not.toHaveBeenCalled();
    expect(stubs.reservePhoto).not.toHaveBeenCalled();
  });
  it("forwards current revision and explicit parent only through the authorized service", async () => {
    const payload = { expectedRevision: 1, idempotencyKey: "checklist-retry-key", answers: [] };
    expect(
      (await POST(request([...path, "checklist"], payload), context([...path, "checklist"])))
        .status,
    ).toBe(200);
    expect(stubs.saveChecklist).toHaveBeenCalledWith({ ...scope, ...payload });
  });
});
