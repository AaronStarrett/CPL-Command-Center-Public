import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRenderer } from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";

const artifact: AiCommandArtifactView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  type: "help",
  title: "Northstar briefing",
  subtitle: "DRAFT — HUMAN REVIEW REQUIRED",
  state: "ready",
  payload: {
    artifactId: "art_0123456789abcdef0123456789abcdef",
    schemaVersion: 1,
    renderer: "pdf",
    title: "Northstar briefing",
    summary: "Authorized evaluation evidence remains synthetic.",
    disclosure:
      "Generated using live OpenAI with synthetic BEA evaluation records. External BEA systems are not connected.",
    ownerId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-31T00:00:00.000Z",
    citations: [],
    brand: {
      organization: "Cyber Pirate Labs",
      policyVersion: "bea-artifact-brand-v1",
      templateVersion: "bea-artifact-template-v1",
      theme: "cpl-light-premium",
      renderer: "pdf",
      logoPath: "/brand/cpl-logo.png",
      palette: [],
      normalizedByApplication: true,
    },
    file: {
      id: "art_0123456789abcdef0123456789abcdef",
      filename: "BEA-Executive-Briefing-Northstar-2026-08-31-v1.pdf",
      mimeType: "application/pdf",
      sha256: "a".repeat(64),
      size: 2048,
    },
    executiveDocument: {
      reviewLabel: "DRAFT — HUMAN REVIEW REQUIRED",
      version: 2,
      parentVersion: 1,
      relatedLeadPath: "/leads/55555555-5555-4555-8555-555555555555",
      versions: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          version: 2,
          title: "Northstar briefing",
          createdAt: "2026-08-31T00:00:00.000Z",
        },
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          version: 1,
          title: "Northstar briefing",
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    },
  },
  sources: [],
  links: [
    { label: "Download PDF", href: "/api/artifacts/art_0123456789abcdef0123456789abcdef/download" },
  ],
  requiredPermissions: ["ai-command.view", "documents.view"],
  createdAt: "2026-08-31T00:00:00.000Z",
  errorCode: null,
};

describe("Phase 2.2 PDF workspace chrome", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows draft review, version history, related lead, and download without leaving AI Command", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
        headers: new Headers({ "Content-Type": "application/pdf", "Content-Length": "4" }),
        ok: true,
        status: 200,
      })),
    );
    render(
      <WorkspaceRenderer
        artifact={artifact}
        canExecuteTaskAction={false}
        onConfirmAction={() => undefined}
        titleRenderedByParent
      />,
    );
    expect(screen.getByTestId("executive-pdf-review-status")).toHaveTextContent(
      "DRAFT — HUMAN REVIEW REQUIRED",
    );
    expect(screen.getByTestId("executive-pdf-version-history")).toHaveTextContent("v1");
    expect(screen.getByTestId("executive-pdf-version-history")).toHaveTextContent("v2");
    expect(screen.getByTestId("executive-pdf-open-lead")).toHaveAttribute(
      "href",
      "/leads/55555555-5555-4555-8555-555555555555",
    );
    expect(screen.getByTestId("application-pdf-viewer")).toBeInTheDocument();
  });
});
