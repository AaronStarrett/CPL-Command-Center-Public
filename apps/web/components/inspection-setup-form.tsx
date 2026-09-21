"use client";

import { Alert, Button, FormField, Input, Select } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function InspectionSetupForm({
  projects,
  releases,
  users,
}: {
  projects: readonly { id: string; reference: string; name: string }[];
  releases: readonly {
    id: string;
    displayName: string;
    versionNumber: number;
    status: string;
    synthetic: boolean;
  }[];
  users: readonly { id: string; displayName: string }[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [configurationReleaseId, setConfigurationReleaseId] = useState(
    releases.find((item) => item.status === "active")?.id ?? releases[0]?.id ?? "",
  );
  const [inspectionType, setInspectionType] = useState("");
  const [inspectorUserId, setInspectorUserId] = useState(users[0]?.id ?? "");
  const [scheduledAt, setScheduledAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-inspection",
          projectId,
          configurationReleaseId,
          inspectionType,
          inspectorUserId,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        inspection?: { id: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "Inspection setup failed.");
        return;
      }
      if (payload.inspection?.id) {
        router.push(`/inspections/${payload.inspection.id}`);
      }
    } catch {
      setError("Inspection setup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="bea-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <FormField label="Existing project" htmlFor="inspection-project" required>
        <Select
          id="inspection-project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          data-testid="inspection-project"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.reference} · {project.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label="Configuration release"
        htmlFor="inspection-release"
        hint="Use a synthetic or published release. Unconfigured BEA production drafts cannot be selected for activation."
        required
      >
        <Select
          id="inspection-release"
          value={configurationReleaseId}
          onChange={(event) => setConfigurationReleaseId(event.target.value)}
          data-testid="inspection-release"
        >
          {releases
            .filter((release) => release.status === "active" || release.status === "published")
            .map((release) => (
              <option key={release.id} value={release.id}>
                {release.displayName} v{release.versionNumber} · {release.status}
                {release.synthetic ? " · synthetic" : ""}
              </option>
            ))}
        </Select>
      </FormField>
      <FormField label="Inspection type" htmlFor="inspection-type">
        <Input
          id="inspection-type"
          value={inspectionType}
          onChange={(event) => setInspectionType(event.target.value)}
          data-testid="inspection-type"
        />
      </FormField>
      <FormField label="Inspector" htmlFor="inspection-inspector">
        <Select
          id="inspection-inspector"
          value={inspectorUserId}
          onChange={(event) => setInspectorUserId(event.target.value)}
        >
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Scheduled time" htmlFor="inspection-scheduled">
        <Input
          id="inspection-scheduled"
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
        />
      </FormField>
      <Button type="submit" data-testid="inspection-create" disabled={busy}>
        {busy ? "Creating…" : "Create inspection"}
      </Button>
    </form>
  );
}
