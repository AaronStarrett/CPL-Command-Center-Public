import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationReleaseActions } from "../../apps/web/components/configuration-release-actions";
import { ConfigurationMappingLab } from "../../apps/web/components/configuration-mapping-lab";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 3.1A configuration studio actions", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("validates a draft from the release actions", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ passed: true, release: { status: "validated" } }));
    render(
      <ConfigurationReleaseActions
        releaseId="c1000000-0000-4000-8000-000000000001"
        status="draft"
        canDraft
        canValidate
        canPublish
        canActivate
        canArchive
      />,
    );
    fireEvent.click(screen.getByTestId("configuration-validate"));
    await screen.findByText(/Configuration validate completed/i);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/configuration",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("runs a mapping dry-run from the synthetic lab", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ inspectionCreated: false, mapping: { humanReadable: ["Mapped"] } }),
    );
    render(
      <ConfigurationMappingLab
        releases={[
          {
            id: "rel-1",
            displayName: "Synthetic Exterior Observation",
            versionNumber: 1,
            synthetic: true,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByTestId("lab-raw"), { target: { value: '{"client":"demo"}' } });
    fireEvent.click(screen.getByTestId("lab-dry-run"));
    await screen.findByTestId("lab-result");
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      action: "dry-run-mapping",
    });
  });
});
