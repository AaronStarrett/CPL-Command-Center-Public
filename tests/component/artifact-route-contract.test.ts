import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactRoutePolicy,
  finalizeArtifactRouteResponse,
} from "../../apps/web/lib/artifact-route-contract";

describe("artifact web route contract", () => {
  it("maps preview, download, refresh, and upload to explicit least-privilege policies", () => {
    expect(artifactRoutePolicy("preview")).toMatchObject({
      artifactPermissions: ["artifacts:read"],
      mutation: false,
      rbacPermissions: ["documents.view"],
    });
    expect(artifactRoutePolicy("download")).toMatchObject({
      artifactPermissions: ["artifacts:download"],
      mutation: false,
      rbacPermissions: ["documents.view"],
    });
    expect(artifactRoutePolicy("refresh")).toEqual(artifactRoutePolicy("preview"));
    expect(artifactRoutePolicy("upload")).toMatchObject({
      artifactPermissions: ["artifacts:write"],
      mutation: true,
      rbacPermissions: ["documents.view", "ai-command.run"],
    });
  });

  it("forces private no-store and correlation headers without dropping safe download headers", () => {
    const response = finalizeArtifactRouteResponse(
      new Response("synthetic artifact", {
        headers: {
          "content-disposition": 'attachment; filename="synthetic.txt"',
          "content-type": "text/plain",
        },
      }),
      "artifact-route-contract-test",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-correlation-id")).toBe("artifact-route-contract-test");
    expect(response.headers.get("content-disposition")).toContain("synthetic.txt");
  });

  it("rechecks persisted permissions before every artifact-file read seam", () => {
    for (const [route, responseHelper] of [
      ["preview/route.ts", "createArtifactPreviewResponse"],
      ["download/route.ts", "createArtifactDownloadResponse"],
      ["route.ts", "createArtifactRefreshResponse"],
    ] as const) {
      const source = readFileSync(
        join(process.cwd(), "apps", "web", "app", "api", "artifacts", "[id]", route),
        "utf8",
      );
      const accessCheck = source.indexOf("requirePersistedArtifactAccess(context, id");
      const fileRead = source.indexOf(`${responseHelper}(context.store`);
      expect(accessCheck).toBeGreaterThan(-1);
      expect(fileRead).toBeGreaterThan(accessCheck);
    }
  });

  it("uses transactional upload persistence and compensates only the acquired file lease", () => {
    const source = readFileSync(
      join(process.cwd(), "apps", "web", "app", "api", "artifacts", "upload", "route.ts"),
      "utf8",
    );
    expect(source).toContain("await persistUploadedArtifact({");
    expect(source).toContain(
      "await context.store.delete(context.authorization.ownerId, artifact.id)",
    );
    expect(source.indexOf("await persistUploadedArtifact({")).toBeLessThan(
      source.indexOf("await context.store.delete(context.authorization.ownerId, artifact.id)"),
    );
  });
});
