"use client";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@bea/ui";
import { useState, type FormEvent } from "react";

import { AppLogo } from "@/components/app-logo";
import type { ExecutiveProfileAdministrationSnapshot } from "@/lib/executive-profile-administration";

function lines(values: readonly string[]): string {
  return values.join("\n");
}

function parsedLines(value: FormDataEntryValue | null): readonly string[] {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ExecutiveProfileAdministrationPanel({
  initial,
}: {
  initial: ExecutiveProfileAdministrationSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showPersonaPreview, setShowPersonaPreview] = useState(false);
  const [showThemePreview, setShowThemePreview] = useState(false);
  const [selectedPromptVersion, setSelectedPromptVersion] = useState(
    initial.personaPolicy.activeVersion,
  );

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/administration/executive-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ExecutiveProfileAdministrationSnapshot & {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(result.error?.message ?? "Executive Profile update failed.");
      setSnapshot(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Executive Profile update failed.");
    } finally {
      setBusy(false);
    }
  }

  function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void patch({
      operation: "update-profile",
      expectedVersion: snapshot.profileSettingVersion,
      profile: {
        fullName: data.get("fullName"),
        preferredName: data.get("preferredName"),
        title: data.get("title"),
        professionalSummary: data.get("professionalSummary"),
        businessPriorities: parsedLines(data.get("businessPriorities")),
        communicationPreferences: parsedLines(data.get("communicationPreferences")),
        decisionPreferences: parsedLines(data.get("decisionPreferences")),
        approvedPersonalInterests: parsedLines(data.get("approvedPersonalInterests")),
      },
    });
  }

  function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void patch({
      operation: "add-source",
      expectedVersion: snapshot.profileSettingVersion,
      source: {
        type: data.get("sourceType"),
        label: data.get("sourceLabel"),
        url: data.get("sourceUrl"),
        accessNote: data.get("sourceNote"),
      },
    });
  }

  const profile = snapshot.activeProfile;
  return (
    <Card data-testid="executive-profile-administration">
      <CardHeader>
        <div className="bea-cluster bea-ai-artifact__heading">
          <div>
            <CardTitle>Executive Profile</CardTitle>
            <CardDescription>
              Owner-only, source-backed personalization. Private profile values remain server-side.
            </CardDescription>
          </div>
          <Badge tone="success">{profile.version}</Badge>
        </div>
      </CardHeader>
      <CardContent className="bea-stack bea-stack--large">
        {error ? (
          <Alert tone="danger" title="Profile change not applied">
            {error}
          </Alert>
        ) : null}
        <form className="bea-stack" onSubmit={updateProfile}>
          <div className="bea-form-grid">
            <label>
              Full name
              <input
                className="bea-input"
                name="fullName"
                defaultValue={profile.fullName}
                required
                maxLength={120}
              />
            </label>
            <label>
              Preferred name
              <input
                className="bea-input"
                name="preferredName"
                defaultValue={profile.preferredName}
                required
                maxLength={80}
              />
            </label>
            <label>
              Title
              <input
                className="bea-input"
                name="title"
                defaultValue={profile.title}
                required
                maxLength={120}
              />
            </label>
            <label>
              Last reviewed
              <input
                className="bea-input"
                value={new Date(profile.reviewedAt).toLocaleString("en-US")}
                readOnly
              />
            </label>
          </div>
          <label>
            Public professional summary
            <textarea
              className="bea-textarea"
              name="professionalSummary"
              defaultValue={profile.professionalSummary}
              required
              maxLength={1200}
            />
          </label>
          <div className="bea-form-grid">
            <label>
              Approved business priorities
              <textarea
                className="bea-textarea"
                name="businessPriorities"
                defaultValue={lines(profile.businessPriorities)}
                required
              />
            </label>
            <label>
              Communication preferences
              <textarea
                className="bea-textarea"
                name="communicationPreferences"
                defaultValue={lines(profile.communicationPreferences)}
                required
              />
            </label>
            <label>
              Decision preferences
              <textarea
                className="bea-textarea"
                name="decisionPreferences"
                defaultValue={lines(profile.decisionPreferences)}
                required
              />
            </label>
            <label>
              Approved personal interests
              <textarea
                className="bea-textarea"
                name="approvedPersonalInterests"
                defaultValue={lines(profile.approvedPersonalInterests)}
                required
              />
            </label>
          </div>
          <div className="bea-cluster">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving version…" : "Save corrected version"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowPersonaPreview((value) => !value)}
            >
              Preview persona
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowThemePreview((value) => !value)}
            >
              Preview CPL theme
            </Button>
          </div>
        </form>
        {showPersonaPreview ? (
          <Alert tone="info" title={`Persona preview · ${snapshot.personaPolicy.activeVersion}`}>
            {snapshot.preview}
          </Alert>
        ) : null}
        {showThemePreview ? (
          <div className="bea-brand-policy-preview" data-testid="bea-brand-policy-preview">
            <AppLogo />
            <div>
              {snapshot.brandPolicy.palette.map((color) => (
                <span key={color} style={{ backgroundColor: color }} title={color} />
              ))}
            </div>
            <small>
              {snapshot.brandPolicy.activeVersion} · {snapshot.brandPolicy.templateVersion}
            </small>
          </div>
        ) : null}
        <section className="bea-stack" aria-labelledby="profile-sources-heading">
          <h3 id="profile-sources-heading">Approved sources</h3>
          <ul className="bea-source-administration-list">
            {snapshot.profile.sources.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.label}</strong>
                  <small>
                    {source.type} · {source.status}
                  </small>
                  {source.accessNote ? <p>{source.accessNote}</p> : null}
                </div>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer noopener">
                    Open reference
                  </a>
                ) : null}
                {source.status !== "superseded" ? (
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void patch({
                        operation: "remove-source",
                        expectedVersion: snapshot.profileSettingVersion,
                        sourceId: source.id,
                      })
                    }
                  >
                    Supersede
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <form className="bea-form-grid" onSubmit={addSource}>
            <label>
              Source type
              <select className="bea-select" name="sourceType" defaultValue="OWNER_CORRECTION">
                <option>OWNER_CONFIRMED</option>
                <option>OWNER_CORRECTION</option>
                <option>ORGANIZATION_WEBSITE</option>
                <option>LINKEDIN_REFERENCE</option>
                <option>UPLOADED_BIOGRAPHY</option>
                <option>APPROVED_PUBLIC_SOURCE</option>
              </select>
            </label>
            <label>
              Label
              <input className="bea-input" name="sourceLabel" required maxLength={240} />
            </label>
            <label>
              HTTPS URL (optional)
              <input className="bea-input" name="sourceUrl" type="url" />
            </label>
            <label>
              Access note (optional)
              <input className="bea-input" name="sourceNote" maxLength={500} />
            </label>
            <Button type="submit" variant="secondary" disabled={busy}>
              Add source
            </Button>
          </form>
        </section>
        <section className="bea-stack" aria-labelledby="prompt-versions-heading">
          <h3 id="prompt-versions-heading">Prompt versions</h3>
          <div className="bea-cluster">
            <Badge tone="info">Active: {snapshot.personaPolicy.activeVersion}</Badge>
            <label>
              Prompt version
              <select
                className="bea-select"
                aria-label="Prompt version"
                value={selectedPromptVersion}
                onChange={(event) => setSelectedPromptVersion(event.currentTarget.value)}
              >
                {snapshot.personaPolicy.availableVersions.map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void patch({
                  operation: "activate-prompt",
                  expectedVersion: snapshot.personaSettingVersion,
                  version: selectedPromptVersion,
                })
              }
            >
              Activate selected
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={busy || snapshot.personaPolicy.availableVersions.length < 2}
              onClick={() =>
                void patch({
                  operation: "rollback-prompt",
                  expectedVersion: snapshot.personaSettingVersion,
                })
              }
            >
              Roll back
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
