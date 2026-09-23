// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  workspace: vi.fn(),
  getPackage: vi.fn(),
  attachment: vi.fn(),
  storage: vi.fn(),
  getVerified: vi.fn(),
  createPackage: vi.fn(),
  savePackage: vi.fn(),
  revisePackage: vi.fn(),
  markReady: vi.fn(),
  recordExport: vi.fn(),
  recordSent: vi.fn(),
  acknowledge: vi.fn(),
  withdrawApproval: vi.fn(),
  savePolicy: vi.fn(),
  saveCloseoutFacts: vi.fn(),
  overrideReadiness: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (runtime: unknown) => Promise<unknown>) =>
    operation({ tenants: {} }),
  requireHostedSession: s.session,
  requireHostedMutation: s.mutation,
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplDeliveryRepository: class {
    workspace = s.workspace;
    getPackage = s.getPackage;
    attachment = s.attachment;
    createPackage = s.createPackage;
    savePackage = s.savePackage;
    revisePackage = s.revisePackage;
    markReady = s.markReady;
    recordExport = s.recordExport;
    recordSent = s.recordSent;
    acknowledge = s.acknowledge;
    withdrawApproval = s.withdrawApproval;
    savePolicy = s.savePolicy;
    saveCloseoutFacts = s.saveCloseoutFacts;
    overrideReadiness = s.overrideReadiness;
  },
}));
vi.mock("@/lib/cpl-evidence-runtime", () => ({ cplEvidenceStorage: s.storage }));
import { GET, POST } from "../../apps/web/app/api/cpl-delivery/[...path]/route";
const organizationId = "123e4567-e89b-12d3-a456-426614174000",
  projectId = "123e4567-e89b-12d3-a456-426614174001",
  packageId = "123e4567-e89b-12d3-a456-426614174002",
  reportId = "123e4567-e89b-12d3-a456-426614174003";
const projectPath = ["projects", projectId],
  packagePath = [...projectPath, "packages", packageId],
  scope = { sessionToken: "synthetic-session", organizationId, projectId, packageId },
  edit = { expectedRevision: 2, idempotencyKey: "fictional-delivery-action" };
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
function request(
  path: string[],
  value?: unknown,
  query = "",
  headers: Record<string, string> = {},
) {
  return new Request("http://127.0.0.1:3400/api/cpl-delivery/" + path.join("/") + query, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": organizationId,
      ...headers,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
const pkg = {
  id: packageId,
  projectId,
  reference: "DEL-FICTIONAL",
  revision: 2,
  currentVersion: 1,
  state: "ready",
  readiness: { ready: true, reasons: [] },
  events: [],
  versions: [
    {
      version: 1,
      input: {
        customerName: "Fictional customer",
        contactName: "Example person",
        recipient: "example@customer.invalid",
        subject: "Fictional report",
        message: "Please review the attached fictional example.",
        attachments: [{ reportId, version: 4 }],
      },
      attachments: [
        {
          reportId,
          version: 4,
          reference: "RPT-FICTIONAL",
          title: "Approved fictional report",
          sha256: "a".repeat(64),
          byteLength: 4,
          approvedAt: "2026-09-23T12:00:00Z",
        },
      ],
      preparedByIdentityId: "private-actor",
      preparedAt: "2026-09-23T12:10:00Z",
      state: "ready",
    },
  ],
  internalNotes: "PRIVATE-DO-NOT-EXPORT",
};
describe("delivery HTTP version and disclosure boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const session = {
      sessionToken: scope.sessionToken,
      session: { selectedOrganizationId: organizationId },
    };
    s.session.mockResolvedValue(session);
    s.mutation.mockResolvedValue(session);
    s.getPackage.mockResolvedValue(pkg);
    s.storage.mockResolvedValue({ getVerified: s.getVerified });
    s.getVerified.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    s.attachment.mockResolvedValue({
      organizationId,
      objectId: "private-object-id",
      sha256: "a".repeat(64),
      byteLength: 4,
    });
    for (const name of [
      "createPackage",
      "savePackage",
      "revisePackage",
      "markReady",
      "recordExport",
      "recordSent",
      "acknowledge",
    ] as const)
      s[name].mockResolvedValue(pkg);
  });
  it("rejects unauthenticated downloads and CSRF before opening storage or recording delivery", async () => {
    const path = [...packagePath, "attachments", reportId];
    s.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect(
      (await GET(request(path, undefined, "?version=1&reportVersion=4"), context(path))).status,
    ).toBe(401);
    expect(s.storage).not.toHaveBeenCalled();
    s.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect(
      (
        await POST(
          request([...packagePath, "record-sent"], { ...edit, input: {} }),
          context([...packagePath, "record-sent"]),
        )
      ).status,
    ).toBe(403);
    expect(s.recordSent).not.toHaveBeenCalled();
  });
  it("authorizes exact package, project and report version before retrieving bytes", async () => {
    const path = [...packagePath, "attachments", reportId];
    s.attachment.mockRejectedValue({ code: "CPL_RECORD_NOT_FOUND" });
    expect(
      (await GET(request(path, undefined, "?version=1&reportVersion=4"), context(path))).status,
    ).toBe(404);
    expect(s.attachment).toHaveBeenCalledWith({ ...scope, version: 1, reportId, reportVersion: 4 });
    expect(s.storage).not.toHaveBeenCalled();
  });
  it("downloads the stored approved bytes without selecting the highest report version or regenerating anything", async () => {
    const path = [...packagePath, "attachments", reportId],
      response = await GET(request(path, undefined, "?version=1&reportVersion=4"), context(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-cpl-report-version")).toBe("4");
    expect(response.headers.get("x-cpl-package-version")).toBe("1");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(s.recordExport).not.toHaveBeenCalled();
    expect(s.recordSent).not.toHaveBeenCalled();
  });
  it("rejects missing or duplicated version selectors and conflicting tenant context", async () => {
    const path = [...packagePath, "attachments", reportId];
    for (const query of [
      "",
      "?version=1",
      "?version=1&reportVersion=4&reportVersion=6",
      "?version=-1&reportVersion=4",
    ])
      expect((await GET(request(path, undefined, query), context(path))).status).toBe(400);
    expect(
      (
        await GET(
          request(path, undefined, "?version=1&reportVersion=4&organization=other"),
          context(path),
        )
      ).status,
    ).toBe(409);
    expect(s.attachment).not.toHaveBeenCalled();
  });
  it("exports only allowlisted message/manifest content and never records a send on GET", async () => {
    for (const action of ["manifest", "message"]) {
      const path = [...packagePath, action],
        response = await GET(request(path, undefined, "?version=1"), context(path));
      expect(response.status).toBe(200);
      const output = await response.text();
      expect(output).toContain("RPT-FICTIONAL");
      expect(output).toContain("example@customer.invalid");
      expect(output).not.toContain("private-actor");
      expect(output).not.toContain("PRIVATE-DO-NOT-EXPORT");
      expect(output).not.toContain("private-object-id");
    }
    expect(s.recordSent).not.toHaveBeenCalled();
    expect(s.acknowledge).not.toHaveBeenCalled();
    expect(s.recordExport).not.toHaveBeenCalled();
  });
  it("requires deliberate recipient confirmation and excludes browser approval/artifact claims", async () => {
    for (const addition of [
      { recipientConfirmed: false },
      { recipientConfirmed: true, approved: true },
      { recipientConfirmed: true, artifactObjectId: "forged" },
    ])
      expect(
        (
          await POST(
            request([...packagePath, "ready"], { ...edit, ...addition }),
            context([...packagePath, "ready"]),
          )
        ).status,
      ).toBe(400);
    await POST(
      request([...packagePath, "ready"], { ...edit, recipientConfirmed: true }),
      context([...packagePath, "ready"]),
    );
    expect(s.markReady).toHaveBeenCalledWith({ ...scope, ...edit, recipientConfirmed: true });
  });
  it("keeps explicit export and manual delivery as separate authorized operations", async () => {
    await POST(request([...packagePath, "export"], edit), context([...packagePath, "export"]));
    expect(s.recordExport).toHaveBeenCalledWith({ ...scope, ...edit });
    expect(s.recordSent).not.toHaveBeenCalled();
    const input = {
      sentAt: "2026-09-23T12:30:00Z",
      channel: "Fictional manual test",
      recipient: "example@customer.invalid",
      reference: "Fictional reference",
      note: "Nothing actually sent",
    };
    await POST(
      request([...packagePath, "record-sent"], { ...edit, input }),
      context([...packagePath, "record-sent"]),
    );
    expect(s.recordSent).toHaveBeenCalledWith({ ...scope, ...edit, input });
  });
  it("passes exact withdrawal and override evidence to server authorization without modifying report history in HTTP", async () => {
    s.withdrawApproval.mockResolvedValue({ packages: [] });
    const path = [...projectPath, "reports", reportId, "withdraw"],
      input = {
        version: 4,
        reason: "Fictional review exception",
        idempotencyKey: "withdraw-exact-v4",
      };
    await POST(request(path, input), context(path));
    expect(s.withdrawApproval).toHaveBeenCalledWith({
      sessionToken: scope.sessionToken,
      organizationId,
      projectId,
      reportId,
      ...input,
    });
    s.overrideReadiness.mockResolvedValue({ readiness: { status: "ready" } });
    const override = {
      key: "purchase_order",
      evidenceHash: "a".repeat(64),
      active: true,
      reason: "Authorized fictional exception",
      idempotencyKey: "override",
    };
    await POST(
      request([...projectPath, "override"], override),
      context([...projectPath, "override"]),
    );
    expect(s.overrideReadiness).toHaveBeenCalledWith({
      sessionToken: scope.sessionToken,
      organizationId,
      projectId,
      ...override,
    });
  });
  it("does not expose sending, payment, arbitrary file paths or raw errors", async () => {
    for (const action of ["send", "invoice", "payment", "delete"])
      expect(
        (await POST(request([...packagePath, action], {}), context([...packagePath, action])))
          .status,
      ).toBe(404);
    s.getPackage.mockRejectedValue(new Error("private SQL path D:/secrets"));
    const response = await GET(request(packagePath), context(packagePath));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CPL_WORKSPACE_UNAVAILABLE" });
  });
  it.each(["CPL_FIELD_INVALID_INPUT", "CPL_EXECUTION_INVALID_INPUT"])(
    "preserves shared validator rejection %s as a client input error",
    async (code) => {
      s.acknowledge.mockRejectedValue({ code });
      const path = [...packagePath, "acknowledge"];
      const response = await POST(request(path, { ...edit, input: null }), context(path));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code });
    },
  );
});
