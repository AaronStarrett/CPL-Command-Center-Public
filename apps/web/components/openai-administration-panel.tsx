"use client";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmationDialog,
} from "@bea/ui";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import styles from "@/components/openai-administration.module.css";
import {
  OPENAI_ADMINISTRATION_ENDPOINTS,
  activationReadiness,
  modelCapabilityWarning,
  modelWithCapabilityOverrides,
  normalizeOpenAiModels,
  openAiAdministrationError,
  type OpenAiAdministrationView,
  type OpenAiModelOption,
  type OpenAiModelPurpose,
} from "@/lib/openai-administration-client";
import {
  createUnconfiguredAiRoutingProfile,
  OWNER_PRIMARY_WORKLOAD_ROUTES,
  type AiModelRoutePolicy,
  type AiModelRoutingProfile,
  type AiProviderSettings,
  type AiWorkloadRouteKey,
  type JsonObject,
  AI_ROUTE_PROFILE_LABELS,
} from "@bea/domain";
import { useHydrated } from "@/lib/use-hydrated";
import Link from "next/link";

const capabilityNames = [
  "responsesText",
  "streaming",
  "functionCalling",
  "structuredOutputs",
  "webSearch",
  "codeInterpreter",
  "imageGeneration",
  "fileSearch",
  "fileInput",
  "imageInput",
  "realtime",
  "audioInput",
  "audioOutput",
  "embeddings",
] as const;

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;
const vectorStoreIdPattern = /^vs_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

const workloadLabels: Readonly<Record<AiWorkloadRouteKey, string>> = Object.freeze({
  executive_conversation: "Executive conversation",
  fast_general_conversation: "Fast general conversation",
  complex_reasoning_strategy: "Complex reasoning and strategy",
  public_web_research: "Public web research",
  organizational_file_search: "Organizational file search",
  document_report_drafting: "Document and report drafting",
  pdf_narrative_generation: "PDF narrative generation",
  data_analysis_chart_preparation: "Data analysis and chart preparation",
  image_generation: "Image generation",
  vision_image_understanding: "Vision and image understanding",
  realtime_voice: "Realtime voice",
  embeddings_indexing: "Embeddings and indexing",
});

type BusyAction =
  "activate" | "connect" | "disconnect" | "load" | "models" | "preference" | "save" | "test";

function cloneRoutingProfile(profile: AiModelRoutingProfile): AiModelRoutingProfile {
  return {
    ...profile,
    routes: Object.fromEntries(
      Object.entries(profile.routes).map(([routeKey, route]) => [
        routeKey,
        {
          ...route,
          requiredCapabilities: [...route.requiredCapabilities],
          toolAllowlist: [...route.toolAllowlist],
          roleAvailability: [...route.roleAvailability],
        },
      ]),
    ) as unknown as AiModelRoutingProfile["routes"],
    vectorStoreAssignments: profile.vectorStoreAssignments.map((assignment) => ({
      ...assignment,
      allowedRoleKeys: [...assignment.allowedRoleKeys],
    })),
  };
}

function routeCapabilityAssessment(
  route: AiModelRoutePolicy,
  models: readonly OpenAiModelOption[],
  overrides: AiProviderSettings["modelCapabilityOverrides"],
): { readonly status: "disabled" | "ready" | "setup" | "warning"; readonly detail: string } {
  if (!route.enabled) return { status: "disabled", detail: "Route disabled." };
  if (!route.primaryModel) {
    return { status: "setup", detail: "Select a primary model before activation." };
  }
  const model = modelWithCapabilityOverrides(
    models.find((candidate) => candidate.id === route.primaryModel),
    overrides,
  );
  if (!model || !model.available) {
    return { status: "warning", detail: "Primary model is absent or unavailable." };
  }
  const incompatible = route.requiredCapabilities.filter(
    (capability) => model.capabilities[capability] === false,
  );
  if (incompatible.length > 0) {
    return {
      status: "warning",
      detail: `Verified incompatible: ${incompatible.join(", ")}.`,
    };
  }
  const unverified = route.requiredCapabilities.filter(
    (capability) => model.capabilities[capability] !== true,
  );
  if (unverified.length > 0) {
    return {
      status: "warning",
      detail: `Unverified capabilities: ${unverified.join(", ")}.`,
    };
  }
  return { status: "ready", detail: "Required capabilities verified." };
}

function settingsFromAdministration(next: OpenAiAdministrationView): AiProviderSettings {
  const rollingResponse = next as unknown as {
    readonly routingProfile?: AiModelRoutingProfile;
    readonly settings: Omit<AiProviderSettings, "routingProfile"> & {
      readonly routingProfile?: AiModelRoutingProfile;
    };
  };
  const routingProfile =
    rollingResponse.routingProfile ??
    rollingResponse.settings.routingProfile ??
    createUnconfiguredAiRoutingProfile();
  return {
    ...next.settings,
    routingProfile: cloneRoutingProfile(routingProfile),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function modelOptionsWithCurrent(
  models: readonly OpenAiModelOption[],
  current: string | null,
): readonly OpenAiModelOption[] {
  if (!current || models.some((model) => model.id === current)) return models;
  return [
    ...models,
    {
      id: current,
      displayName: `${current} (not in cache)`,
      available: false,
      capabilities: {},
      capabilitySource: "unknown",
    },
  ];
}

function ModelField({
  id,
  label,
  models,
  purpose,
  value,
  disabled = false,
  onChange,
  allowOff = false,
  capabilityOverrides,
}: {
  readonly id: string;
  readonly label: string;
  readonly models: readonly OpenAiModelOption[];
  readonly purpose: OpenAiModelPurpose;
  readonly value: string | null;
  readonly disabled?: boolean;
  readonly onChange: (value: string | null) => void;
  readonly allowOff?: boolean;
  readonly capabilityOverrides: AiProviderSettings["modelCapabilityOverrides"];
}) {
  const options = modelOptionsWithCurrent(models, value);
  const selected = modelWithCapabilityOverrides(
    options.find((model) => model.id === value),
    capabilityOverrides,
  );
  const warning = value ? modelCapabilityWarning(selected, purpose) : null;
  const knownCapabilities = selected
    ? Object.entries(selected.capabilities)
        .filter(([, state]) => state === true)
        .map(([name]) => name)
    : [];
  return (
    <label className={styles.field} htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        data-testid={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {allowOff ? <option value="">Off</option> : null}
        {!allowOff && options.length === 0 ? (
          <option value="">
            OpenAI returned zero available models for this project credential.
          </option>
        ) : null}
        {options.map((model) => {
          const effective = modelWithCapabilityOverrides(model, capabilityOverrides);
          const suitability = modelCapabilityWarning(effective, purpose)
            ? `${purpose} unverified`
            : `${purpose} suitable`;
          return (
            <option value={model.id} key={model.id}>
              {model.displayName} · OpenAI · {suitability}
              {model.available ? "" : " · unavailable"}
            </option>
          );
        })}
      </select>
      {warning ? (
        <span className={styles.warning} data-testid="openai-model-warning">
          {warning}
        </span>
      ) : (
        <span className={styles.verified}>Required capabilities verified.</span>
      )}
      {selected ? (
        <span className={styles.modelSummary} data-testid="openai-model-summary">
          ID: {selected.id} · Provider: OpenAI · Evidence: {selected.capabilitySource} · Known:{" "}
          {knownCapabilities.length > 0 ? knownCapabilities.join(", ") : "none"}
        </span>
      ) : null}
    </label>
  );
}

function ToggleField({
  checked,
  disabled = false,
  label,
  detail,
  testId,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly testId?: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </label>
  );
}

function NumericField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  nullable = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly suffix?: string;
  readonly nullable?: boolean;
  readonly onChange: (value: number | null) => void;
}) {
  return (
    <label className={styles.field} htmlFor={id}>
      <span>{label}</span>
      <span className={styles.numberControl}>
        <input
          id={id}
          data-testid={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          onChange={(event) => {
            if (nullable && event.target.value === "") {
              onChange(null);
              return;
            }
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        {suffix ? <small>{suffix}</small> : null}
      </span>
    </label>
  );
}

function AdministrationSection({
  title,
  summary,
  children,
  open = false,
}: {
  readonly title: string;
  readonly summary: string;
  readonly children: ReactNode;
  readonly open?: boolean;
}) {
  return (
    <details className={styles.section} open={open}>
      <summary>
        <strong>{title}</strong>
        <span>{summary}</span>
      </summary>
      <div className={styles.sectionBody}>{children}</div>
    </details>
  );
}

export function OpenAiAdministrationPanel({
  compact = false,
}: { readonly compact?: boolean } = {}) {
  const router = useRouter();
  const routerRef = useRef(router);
  const hydrated = useHydrated();
  const [administration, setAdministration] = useState<OpenAiAdministrationView>();
  const [settings, setSettings] = useState<AiProviderSettings>();
  const [models, setModels] = useState<readonly OpenAiModelOption[]>([]);
  const [manualModelId, setManualModelId] = useState("");
  const [manualModelPurpose, setManualModelPurpose] = useState<OpenAiModelPurpose>("text");
  const [capabilityModelId, setCapabilityModelId] = useState("");
  const [capabilityAttested, setCapabilityAttested] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [vectorStoreId, setVectorStoreId] = useState("");
  const [vectorStoreName, setVectorStoreName] = useState("");
  const [testingRoute, setTestingRoute] = useState<AiWorkloadRouteKey>();
  const [routeTestResults, setRouteTestResults] = useState<
    Partial<Record<AiWorkloadRouteKey, string>>
  >({});
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState<BusyAction | undefined>("load");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  function applyAdministration(next: OpenAiAdministrationView) {
    setAdministration(next);
    setSettings(settingsFromAdministration(next));
    setModels(normalizeOpenAiModels(next.cachedModels));
  }

  const request = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(path, init);
    if (response.status === 401) {
      routerRef.current.replace("/sign-in?reason=expired");
      throw new Error("Your session expired.");
    }
    return response;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void request(OPENAI_ADMINISTRATION_ENDPOINTS.settings, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw await openAiAdministrationError(response);
        return (await response.json()) as OpenAiAdministrationView;
      })
      .then((next) => {
        setAdministration(next);
        setSettings(settingsFromAdministration(next));
        setModels(normalizeOpenAiModels(next.cachedModels));
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(
          caught instanceof Error ? caught.message : "OpenAI administration is unavailable.",
        );
      })
      .finally(() => setBusy((current) => (current === "load" ? undefined : current)));
    return () => controller.abort();
  }, [request]);

  function update<K extends keyof AiProviderSettings>(name: K, value: AiProviderSettings[K]) {
    setSettings((current) => (current ? { ...current, [name]: value } : current));
  }

  function updateRoute(routeKey: AiWorkloadRouteKey, patch: Partial<AiModelRoutePolicy>): void {
    setSettings((current) => {
      if (!current) return current;
      const route = current.routingProfile.routes[routeKey];
      return {
        ...current,
        routingProfile: {
          ...current.routingProfile,
          routes: {
            ...current.routingProfile.routes,
            [routeKey]: { ...route, ...patch, routeKey },
          },
        },
      };
    });
  }

  function resetRoutesToRecommendations(): void {
    update(
      "routingProfile",
      cloneRoutingProfile(administration?.recommendedRoutingProfile ?? settings!.routingProfile),
    );
    setError(undefined);
    setNotice("Recommended routes loaded for review. Save settings to apply them transactionally.");
  }

  function addVectorStoreAssignment(): void {
    if (!settings) return;
    const id = vectorStoreId.trim();
    if (!vectorStoreIdPattern.test(id)) {
      setError(
        "Vector store IDs must start with vs_ and contain only letters, numbers, underscores, or hyphens.",
      );
      return;
    }
    if (
      settings.routingProfile.vectorStoreAssignments.some(
        (assignment) => assignment.vectorStoreId === id,
      )
    ) {
      setError("That vector store is already assigned.");
      return;
    }
    update("routingProfile", {
      ...settings.routingProfile,
      vectorStoreAssignments: [
        ...settings.routingProfile.vectorStoreAssignments,
        {
          vectorStoreId: id,
          displayName: vectorStoreName.trim() || id,
          allowedRoleKeys: ["owner-admin", "integration-admin"],
          enabled: true,
        },
      ],
    });
    setVectorStoreId("");
    setVectorStoreName("");
    setError(undefined);
    setNotice("Vector store assignment added for review. Save settings to apply it.");
  }

  function updateVectorStoreAssignment(
    id: string,
    patch: Partial<AiModelRoutingProfile["vectorStoreAssignments"][number]>,
  ): void {
    if (!settings) return;
    update("routingProfile", {
      ...settings.routingProfile,
      vectorStoreAssignments: settings.routingProfile.vectorStoreAssignments.map((assignment) =>
        assignment.vectorStoreId === id ? { ...assignment, ...patch } : assignment,
      ),
    });
  }

  function removeVectorStoreAssignment(id: string): void {
    if (!settings) return;
    update("routingProfile", {
      ...settings.routingProfile,
      vectorStoreAssignments: settings.routingProfile.vectorStoreAssignments.filter(
        (assignment) => assignment.vectorStoreId !== id,
      ),
    });
    setNotice("Vector store assignment removed from the draft. Save settings to apply it.");
  }

  function applyManualModelId() {
    const modelId = manualModelId.trim();
    if (!modelIdPattern.test(modelId)) {
      setError("The manual model ID is invalid.");
      return;
    }
    if (
      settings?.mode !== "demo" &&
      !models.some((model) => model.id === modelId && model.available)
    ) {
      setError("A live OpenAI model must exist in the current refreshed provider cache.");
      return;
    }
    if (manualModelPurpose === "text") update("defaultTextModel", modelId);
    if (manualModelPurpose === "realtime") update("defaultRealtimeModel", modelId);
    if (manualModelPurpose === "transcription") update("inputTranscriptionModel", modelId);
    setCapabilityModelId(modelId);
    setManualModelId("");
    setError(undefined);
    setNotice(
      `Manual ${manualModelPurpose} model ID selected; compatibility remains evidence-gated.`,
    );
  }

  function updateCapabilityOverride(
    modelId: string,
    name: (typeof capabilityNames)[number],
    state: "unknown" | "true" | "false",
  ) {
    if (!settings || !models.some((model) => model.id === modelId && model.available)) {
      setError("Capability verification requires a currently refreshed, available provider model.");
      return;
    }
    const existing = isRecord(settings.modelCapabilityOverrides[modelId])
      ? settings.modelCapabilityOverrides[modelId]
      : {};
    const nextModel = {
      ...existing,
      [name]: state === "true" ? true : state === "false" ? false : "unknown",
    };
    update("modelCapabilityOverrides", {
      ...settings.modelCapabilityOverrides,
      [modelId]: nextModel,
    } as JsonObject);
    setError(undefined);
  }

  async function saveSettings() {
    if (!settings) return;
    setBusy("save");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.settings, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      const body = (await response.json()) as { readonly settings?: AiProviderSettings };
      const savedSettings = body.settings;
      if (!savedSettings) throw new Error("The server did not return saved provider settings.");
      setSettings(savedSettings);
      setAdministration((current) =>
        current
          ? {
              ...current,
              settings: savedSettings,
              routingProfile: cloneRoutingProfile(savedSettings.routingProfile),
              vectorStoreIds: savedSettings.routingProfile.vectorStoreAssignments.map(
                (assignment) => assignment.vectorStoreId,
              ),
            }
          : current,
      );
      setNotice("Provider settings saved. Secret configuration was not changed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Provider settings could not be saved.");
    } finally {
      setBusy(undefined);
    }
  }

  async function updateSpeakResponses(next: boolean) {
    setBusy("preference");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.preferences, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakResponses: next }),
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      const body = (await response.json()) as {
        readonly preference?: { readonly speakResponses?: unknown };
      };
      if (body.preference?.speakResponses !== next) {
        throw new Error("Speak responses could not be saved.");
      }
      setAdministration((current) =>
        current
          ? {
              ...current,
              voicePreference: current.voicePreference
                ? {
                    ...current.voicePreference,
                    speakResponses: next,
                    updatedAt: new Date().toISOString(),
                  }
                : {
                    id: "voice-preference",
                    userId: "",
                    speakResponses: next,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    version: 1,
                  },
            }
          : current,
      );
      setNotice(next ? "Spoken replies are on." : "Speak responses is off.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Speak responses could not be saved.");
    } finally {
      setBusy(undefined);
    }
  }

  async function connectOpenAi(useExistingCredential = false) {
    if (!useExistingCredential && !apiKey.trim()) return;
    setBusy("connect");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.connect, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          useExistingCredential ? { useExistingCredential: true } : { apiKey: apiKey.trim() },
        ),
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      applyAdministration((await response.json()) as OpenAiAdministrationView);
      setNotice(
        useExistingCredential
          ? "Server credential tested. Project models were discovered and are ready to review."
          : "OpenAI connected. Recommended models were discovered and are ready to review.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "OpenAI could not be connected from this key.",
      );
    } finally {
      setApiKey("");
      setBusy(undefined);
    }
  }

  async function verifySelectedModels() {
    setBusy("models");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.verify, { method: "POST" });
      if (!response.ok) throw await openAiAdministrationError(response);
      applyAdministration((await response.json()) as OpenAiAdministrationView);
      setNotice("Selected models were probed for BEA capabilities.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Model verification failed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function disconnect() {
    setConfirmDisconnect(false);
    setBusy("disconnect");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.secret, {
        method: "DELETE",
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      const next = (await response.json()) as OpenAiAdministrationView;
      applyAdministration(next);
      setNotice("OpenAI was disabled and the protected key was deleted.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OpenAI could not be disconnected.");
    } finally {
      setBusy(undefined);
    }
  }

  async function testConnection() {
    setBusy("test");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.test, { method: "POST" });
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as unknown;
      const result = isRecord(body) && isRecord(body.result) ? body.result : null;
      if (!response.ok && !result) throw await openAiAdministrationError(response);
      const refresh = await request(OPENAI_ADMINISTRATION_ENDPOINTS.settings);
      if (!refresh.ok) throw await openAiAdministrationError(refresh);
      applyAdministration((await refresh.json()) as OpenAiAdministrationView);
      const outcome = result?.outcome === "succeeded" ? "succeeded" : "failed";
      setNotice(`Connection test ${outcome}. Review the safe evidence below.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connection test could not complete.");
    } finally {
      setBusy(undefined);
    }
  }

  async function refreshModels() {
    setBusy("models");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.models, { method: "POST" });
      if (!response.ok) throw await openAiAdministrationError(response);
      const body = (await response.json()) as { readonly models?: readonly unknown[] };
      setModels(normalizeOpenAiModels(body.models ?? []));
      setNotice("Provider model inventory refreshed. Capability warnings use server evidence.");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Provider models could not be refreshed.",
      );
    } finally {
      setBusy(undefined);
    }
  }

  async function testRouteConfiguration(routeKey: AiWorkloadRouteKey) {
    setTestingRoute(routeKey);
    setError(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.routeTest, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeKey }),
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      const body = (await response.json()) as unknown;
      const value = isRecord(body) ? body : {};
      const decision = isRecord(value.decision) ? value.decision : {};
      if (value.validation !== "configuration-only" || value.providerCalled !== false) {
        throw new Error("The server did not return configuration-only route evidence.");
      }
      const selectedModel =
        typeof decision.selectedModel === "string" ? decision.selectedModel : "selected model";
      setRouteTestResults((current) => ({
        ...current,
        [routeKey]: `Configuration valid: ${selectedModel}. No provider call was made.`,
      }));
      setNotice(
        `${workloadLabels[routeKey]} passed a configuration-only test. No provider call was made.`,
      );
    } catch (caught) {
      setRouteTestResults((current) => ({
        ...current,
        [routeKey]: "Configuration check failed. No provider call was made.",
      }));
      setError(caught instanceof Error ? caught.message : "The saved route could not be tested.");
    } finally {
      setTestingRoute(undefined);
    }
  }

  async function activate() {
    setBusy("activate");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request(OPENAI_ADMINISTRATION_ENDPOINTS.activate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "openai" }),
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      applyAdministration((await response.json()) as OpenAiAdministrationView);
      setNotice("OpenAI was activated from current server evidence.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OpenAI could not be activated.");
    } finally {
      setBusy(undefined);
    }
  }

  const selectedTextModel = modelWithCapabilityOverrides(
    models.find((model) => model.id === settings?.defaultTextModel),
    settings?.modelCapabilityOverrides ?? {},
  );
  const selectedRealtimeModel = modelWithCapabilityOverrides(
    models.find((model) => model.id === settings?.defaultRealtimeModel),
    settings?.modelCapabilityOverrides ?? {},
  );
  const toolCapability = (name: string) =>
    settings?.mode === "demo" || selectedTextModel?.capabilities[name] === true;
  const activation = useMemo(
    () =>
      administration
        ? activationReadiness(
            { ...administration, settings: settings ?? administration.settings },
            models,
          )
        : { ready: false, reason: "Administration evidence is loading." },
    [administration, models, settings],
  );

  if (!administration || !settings) {
    return (
      <Card data-testid="openai-administration-panel">
        <CardContent>
          {error ? (
            <Alert tone="danger" title="OpenAI administration unavailable">
              {error}
            </Alert>
          ) : (
            <p role="status">Loading restricted OpenAI administration…</p>
          )}
        </CardContent>
      </Card>
    );
  }

  const providerLabel = administration.liveConnected
    ? "OPENAI CONNECTED"
    : busy === "connect"
      ? "OPENAI CONNECTING"
      : error
        ? "OPENAI ERROR"
        : "OPENAI NOT CONNECTED";
  const voiceCatalog = administration.voiceCatalog ?? [];
  const voiceChoices = voiceCatalog.some((voice) => voice.id === settings.defaultVoice)
    ? voiceCatalog
    : [
        {
          id: settings.defaultVoice,
          displayName: `${settings.defaultVoice} (current; not in approved catalog)`,
          description: "This saved voice is not present in the current approved voice catalog.",
          source: "built_in" as const,
          previewAvailable: false,
        },
        ...voiceCatalog,
      ];
  const selectedVoice = voiceChoices.find((voice) => voice.id === settings.defaultVoice);
  const inputTranscriptionModels = modelOptionsWithCurrent(
    models,
    settings.inputTranscriptionModel,
  );
  const capabilityTargetId = capabilityModelId || settings.defaultTextModel;
  const capabilityTarget = models.find((model) => model.id === capabilityTargetId);
  const explicitCapabilityOverrides = isRecord(
    settings.modelCapabilityOverrides[capabilityTargetId],
  )
    ? settings.modelCapabilityOverrides[capabilityTargetId]
    : {};
  const routeEntries = Object.entries(settings.routingProfile.routes) as readonly [
    AiWorkloadRouteKey,
    AiModelRoutePolicy,
  ][];
  const firstRunSteps = [
    {
      label: "Enter and save a masked, project-scoped API key",
      complete: administration.apiKeyStatus === "configured",
    },
    {
      label: "Run an authenticated connection test",
      complete:
        administration.lastTest?.outcome === "succeeded" && administration.lastTest.authenticated,
    },
    {
      label: "Refresh the provider model inventory",
      complete: models.length > 0,
    },
    {
      label: "Review all 12 workload routes and capability warnings",
      complete: routeEntries.every(([, route]) => Boolean(route.primaryModel) || !route.enabled),
    },
    {
      label: "Select the Realtime model and approved voice",
      complete: Boolean(settings.defaultRealtimeModel && selectedVoice),
    },
    {
      label: "Activate from current server evidence",
      complete: administration.liveConnected,
    },
  ];

  return (
    <Card
      className={`${styles.panel} ${compact ? styles.compact : ""}`}
      data-testid="openai-administration-panel"
      data-compact={compact ? "true" : "false"}
    >
      <CardHeader className={styles.header}>
        <div>
          <span className="bea-eyebrow">Restricted administration</span>
          <CardTitle>OpenAI provider</CardTitle>
          <p>Manage safe provider settings and server evidence. Credentials are never displayed.</p>
          {!compact ? (
            <p>
              <Link href="/integrations/ai/owner-acceptance">
                Open Owner Live Acceptance Center
              </Link>
            </p>
          ) : null}
        </div>
        <div className={styles.statusBadges} aria-label="OpenAI provider state">
          <Badge tone={administration.liveConnected ? "success" : "info"}>{providerLabel}</Badge>
          <Badge tone={administration.connectionStatus === "connected" ? "success" : "warning"}>
            {administration.connectionStatus.replaceAll("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className={styles.content}>
        <div className={styles.evidenceGrid}>
          <div data-testid="openai-api-key-status">
            <span>Server API key status</span>
            <strong>{administration.apiKeyStatus}</strong>
            <small>
              Source: {administration.apiKeySource.replaceAll("_", " ")}
              {administration.apiKeyFingerprint ? ` · ${administration.apiKeyFingerprint}` : ""}
            </small>
          </div>
          <div data-testid="openai-connection-status">
            <span>Connection</span>
            <strong>{administration.liveConnected ? "Connected" : "Not connected"}</strong>
            <small>
              {administration.lastTest?.safeMessage ?? "No connection-test evidence yet."}
            </small>
          </div>
          {!compact ? (
            <>
              <div>
                <span>Last authenticated test</span>
                <strong>
                  {administration.lastTest?.authenticated
                    ? administration.lastTest.outcome
                    : "Not available"}
                </strong>
                <small>
                  {administration.lastTest
                    ? `${new Date(administration.lastTest.testedAt).toLocaleString("en-US")} · ${administration.lastTest.latencyMs ?? "—"} ms`
                    : "Run a test before activation."}
                </small>
              </div>
              <div>
                <span>Last successful / failed tests</span>
                <strong>
                  {administration.lastSuccessfulTest ? "Success recorded" : "No success"} ·{" "}
                  {administration.lastFailedTest ? "Failure recorded" : "No failure"}
                </strong>
                <small>
                  Safe evidence only; correlation IDs and error categories remain server-side
                  records.
                </small>
              </div>
            </>
          ) : null}
        </div>

        {!administration.liveConnected ? (
          <section
            className={styles.firstRun}
            data-testid="openai-first-run"
            aria-labelledby="openai-first-run-title"
          >
            <div>
              <span className="bea-eyebrow">First-run setup</span>
              <h2 id="openai-first-run-title">Connect OpenAI</h2>
              <p>
                Complete each evidence-gated step in order. BEA never displays a saved key and does
                not activate live requests from configuration alone.
              </p>
            </div>
            <ol>
              {firstRunSteps.map((step) => (
                <li key={step.label} data-complete={step.complete ? "true" : "false"}>
                  <span aria-hidden="true">{step.complete ? "✓" : "○"}</span>
                  <span>{step.label}</span>
                  <small>{step.complete ? "Complete" : "Required"}</small>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <form
          className={styles.secretPanel}
          data-testid="openai-secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connectOpenAi(Boolean(administration.serverCredentialAvailable) && !apiKey.trim());
          }}
        >
          <div>
            <strong>
              {administration.serverCredentialAvailable
                ? "Server credential available"
                : administration.apiKeyStatus === "configured"
                  ? "Replace API key"
                  : "Configure OpenAI"}
            </strong>
            <p>
              {administration.serverCredentialAvailable
                ? "A server-side project credential is already available. Test the connection to discover models. The credential value is never shown."
                : "Enter a project-scoped OpenAI API key. It stays on this local backend and is persisted only as Windows DPAPI ciphertext. It is never returned after saving."}
            </p>
          </div>
          {administration.serverCredentialAvailable ? (
            <div className="bea-cluster">
              <Button
                type="button"
                size="small"
                data-testid="openai-test-discover"
                disabled={!hydrated || Boolean(busy)}
                onClick={() => void connectOpenAi(true)}
              >
                {busy === "connect" ? "Discovering…" : "Test connection and discover models"}
              </Button>
              {administration.apiKeyStatus !== "not_configured" ? (
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  data-testid="openai-disconnect"
                  disabled={!hydrated || Boolean(busy)}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Disconnect OpenAI
                </Button>
              ) : null}
              <Button
                type="button"
                size="small"
                variant="secondary"
                data-testid="openai-activate"
                disabled={!hydrated || Boolean(busy) || !activation.ready}
                onClick={() => void activate()}
              >
                {busy === "activate" ? "Activating…" : "Activate OpenAI"}
              </Button>
              <small data-testid="openai-activation-readiness">{activation.reason}</small>
            </div>
          ) : (
            <>
              <label className={styles.field} htmlFor="openai-api-key">
                <span>OpenAI API key</span>
                <input
                  id="openai-api-key"
                  data-testid="openai-api-key"
                  type="password"
                  value={apiKey}
                  minLength={20}
                  maxLength={512}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={!administration.protectedStorageAvailable || Boolean(busy)}
                  placeholder="Stored only after you submit"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <div className="bea-cluster">
                <Button
                  type="submit"
                  size="small"
                  data-testid="openai-save-secret"
                  disabled={
                    !hydrated ||
                    Boolean(busy) ||
                    !administration.protectedStorageAvailable ||
                    apiKey.trim().length < 20
                  }
                >
                  {busy === "connect" ? "Connecting…" : "Save key and connect OpenAI"}
                </Button>
                {administration.apiKeyStatus !== "not_configured" ? (
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    data-testid="openai-disconnect"
                    disabled={!hydrated || Boolean(busy)}
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    Disconnect OpenAI
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  data-testid="openai-activate"
                  disabled={!hydrated || Boolean(busy) || !activation.ready}
                  onClick={() => void activate()}
                >
                  {busy === "activate" ? "Activating…" : "Activate OpenAI"}
                </Button>
                <small data-testid="openai-activation-readiness">{activation.reason}</small>
              </div>
            </>
          )}
          {!administration.protectedStorageAvailable &&
          !administration.serverCredentialAvailable ? (
            <small>
              Windows protected storage is unavailable on this computer. Save a key only on Windows
              Owner Evaluation, or use a Cloud server runtime credential. Do not paste the key into
              a file or terminal.
            </small>
          ) : null}
        </form>

        {!compact ? (
          <Alert tone="info" title="Billing boundary">
            <span data-testid="openai-billing-notice">
              {administration.billingNotice} A ChatGPT subscription does not include API usage. Live
              API activity may incur charges.
            </span>
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" title="OpenAI administration request failed">
            {error}
          </Alert>
        ) : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {administration.diagnostics?.zeroModels ? (
          <Alert tone="warning" title="No project models">
            OpenAI returned zero available models for this project credential.
          </Alert>
        ) : null}

        <section data-testid="openai-progressive-readiness" className={styles.ownerRoutes}>
          <strong>Progressive readiness</strong>
          <div className="bea-cluster">
            <Badge
              tone={administration.progressiveActivation?.liveTextReady ? "success" : "warning"}
              data-testid="openai-status-live-text"
            >
              Live text: {administration.progressiveActivation?.liveText ?? "unavailable"}
            </Badge>
            <Badge
              tone={administration.progressiveActivation?.researchReady ? "success" : "info"}
              data-testid="openai-status-web-search"
            >
              Public Web Research:{" "}
              {administration.progressiveActivation?.publicWebResearch ?? "unavailable"}
            </Badge>
            <Badge
              tone={administration.progressiveActivation?.realtimeReady ? "success" : "info"}
              data-testid="openai-status-realtime"
            >
              Realtime Voice: {administration.progressiveActivation?.realtimeVoice ?? "unavailable"}
            </Badge>
            <Badge tone="info" data-testid="openai-status-pdf">
              PDF and Artifacts:{" "}
              {administration.progressiveActivation?.pdfAndArtifacts ?? "unavailable"}
            </Badge>
          </div>
        </section>

        {administration.diagnostics ? (
          <details className={styles.advanced} data-testid="openai-owner-diagnostics">
            <summary>Owner diagnostics</summary>
            <dl>
              <div>
                <dt>Credential source</dt>
                <dd data-testid="openai-diagnostic-credential-source">
                  {administration.diagnostics.credentialSource}
                </dd>
              </div>
              <div>
                <dt>Credential configured</dt>
                <dd>{administration.diagnostics.credentialConfigured ? "yes" : "no"}</dd>
              </div>
              <div>
                <dt>Authenticated test</dt>
                <dd>
                  {administration.diagnostics.authenticatedTest === "not_run"
                    ? "not run"
                    : administration.diagnostics.authenticatedTest}
                </dd>
              </div>
              <div>
                <dt>Model-list request</dt>
                <dd>
                  {administration.diagnostics.modelListRequest === "not_run"
                    ? "not run"
                    : administration.diagnostics.modelListRequest}
                </dd>
              </div>
              <div>
                <dt>Models returned</dt>
                <dd data-testid="openai-diagnostic-models-returned">
                  {administration.diagnostics.modelsReturned}
                </dd>
              </div>
              <div>
                <dt>Models cached</dt>
                <dd>{administration.diagnostics.modelsCached}</dd>
              </div>
              <div>
                <dt>Responses candidates</dt>
                <dd>{administration.diagnostics.responsesCandidates}</dd>
              </div>
              <div>
                <dt>Web Search candidates</dt>
                <dd>{administration.diagnostics.webSearchCandidates}</dd>
              </div>
              <div>
                <dt>Realtime candidates</dt>
                <dd>{administration.diagnostics.realtimeCandidates}</dd>
              </div>
              <div>
                <dt>Activation blockers</dt>
                <dd>{administration.diagnostics.activationBlockers.join(" ") || "None"}</dd>
              </div>
              <div>
                <dt>Last safe error code</dt>
                <dd>{administration.diagnostics.lastSafeErrorCode ?? "none"}</dd>
              </div>
              <div>
                <dt>Correlation ID</dt>
                <dd>{administration.diagnostics.correlationId ?? "none"}</dd>
              </div>
              <div>
                <dt>Last test time</dt>
                <dd>{administration.diagnostics.lastTestTime ?? "not run"}</dd>
              </div>
              <div>
                <dt>Provider latency</dt>
                <dd>
                  {administration.diagnostics.providerLatencyMs === null
                    ? "n/a"
                    : `${administration.diagnostics.providerLatencyMs} ms`}
                </dd>
              </div>
            </dl>
          </details>
        ) : null}

        <section data-testid="openai-project-model-inventory">
          <strong>Available from OpenAI project</strong>
          <p>
            {administration.diagnostics?.modelsReturned ?? models.length} models
            {administration.diagnostics?.lastTestTime
              ? ` · discovered ${administration.diagnostics.lastTestTime}`
              : ""}
            {administration.diagnostics?.credentialSource
              ? ` · ${administration.diagnostics.credentialSource}`
              : ""}
            {administration.diagnostics?.modelListRequest
              ? ` · list ${administration.diagnostics.modelListRequest === "not_run" ? "not run" : administration.diagnostics.modelListRequest}`
              : ""}
          </p>
          {models.length > 0 ? (
            <ul>
              {models.map((model) => (
                <li key={model.id}>
                  {model.displayName}
                  {model.available ? "" : " · unavailable"} · {model.capabilitySource}
                </li>
              ))}
            </ul>
          ) : administration.diagnostics?.zeroModels ? (
            <p>OpenAI returned zero available models for this project credential.</p>
          ) : (
            <p>No project models are cached yet. Test the connection to discover models.</p>
          )}
        </section>

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void saveSettings();
          }}
        >
          <AdministrationSection
            title="Provider and models"
            summary="Mode, model compatibility, voice, and provider evidence"
            open
          >
            <div className={styles.fieldGrid}>
              <div className={styles.field} data-testid="openai-provider-mode">
                <span>OpenAI connection</span>
                <strong data-testid="openai-connection-state">
                  {administration.liveConnected
                    ? "OPENAI CONNECTED"
                    : busy === "connect"
                      ? "OPENAI CONNECTING"
                      : error
                        ? "OPENAI ERROR"
                        : "OPENAI NOT CONNECTED"}
                </strong>
                <small>
                  {administration.serverCredentialAvailable
                    ? "Use the server credential to test connection and discover project models."
                    : "Paste a project-scoped API key and connect. OpenAI is the only owner provider."}
                </small>
              </div>
              <ModelField
                id="openai-text-model"
                label="Default text model"
                models={models}
                purpose="text"
                value={settings.defaultTextModel}
                capabilityOverrides={settings.modelCapabilityOverrides}
                onChange={(value) => value && update("defaultTextModel", value)}
              />
              <ModelField
                id="openai-realtime-model"
                label="Realtime model"
                models={models}
                purpose="realtime"
                value={settings.defaultRealtimeModel}
                capabilityOverrides={settings.modelCapabilityOverrides}
                disabled={!settings.realtimeAllowed}
                onChange={(value) => value && update("defaultRealtimeModel", value)}
              />
              {!compact ? (
                <ModelField
                  id="openai-transcription-model"
                  label="Input transcription model"
                  models={inputTranscriptionModels}
                  purpose="transcription"
                  value={settings.inputTranscriptionModel}
                  capabilityOverrides={settings.modelCapabilityOverrides}
                  allowOff
                  onChange={(value) => update("inputTranscriptionModel", value)}
                />
              ) : null}
              <label className={styles.field} htmlFor="openai-voice">
                <span>Realtime voice</span>
                <select
                  id="openai-voice"
                  data-testid="openai-voice"
                  value={settings.defaultVoice}
                  disabled={!settings.realtimeAllowed}
                  onChange={(event) => update("defaultVoice", event.target.value)}
                >
                  {voiceChoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.displayName}
                    </option>
                  ))}
                </select>
                <small data-testid="openai-voice-description">
                  {selectedVoice?.description ?? "No approved voice metadata is available."} Source:{" "}
                  {selectedVoice?.source.replaceAll("_", " ") ?? "unknown"}. Catalog preview:{" "}
                  {selectedVoice?.previewAvailable ? "available" : "unavailable"}. In-app preview is
                  unavailable in this build.
                </small>
                <Button type="button" size="small" variant="ghost" disabled>
                  Preview unavailable
                </Button>
              </label>
            </div>
            {!compact ? (
              <>
                <div className={styles.manualModel} data-testid="openai-manual-model-controls">
                  <label className={styles.field} htmlFor="openai-manual-model-purpose">
                    <span>Manual model purpose</span>
                    <select
                      id="openai-manual-model-purpose"
                      value={manualModelPurpose}
                      onChange={(event) =>
                        setManualModelPurpose(event.target.value as OpenAiModelPurpose)
                      }
                    >
                      <option value="text">Text</option>
                      <option value="realtime">Realtime</option>
                      <option value="transcription">Transcription</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor="openai-manual-model-id">
                    <span>Manual model ID</span>
                    <input
                      id="openai-manual-model-id"
                      data-testid="openai-manual-model-id"
                      value={manualModelId}
                      maxLength={255}
                      placeholder="Provider model ID"
                      onChange={(event) => setManualModelId(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    data-testid="openai-apply-manual-model"
                    disabled={!manualModelId.trim()}
                    onClick={applyManualModelId}
                  >
                    Apply manual ID
                  </Button>
                  <small>
                    Manual IDs remain unsuitable until verified. While connected, the server rejects
                    IDs absent from the current refreshed OpenAI model cache.
                  </small>
                </div>

                <div className={styles.capabilityEditor} data-testid="openai-capability-editor">
                  <div>
                    <h3>Restricted capability verification</h3>
                    <p>
                      The provider Models API does not supply a complete capability matrix. These
                      tri-state overrides are owner attestations, are audited, and can only target a
                      currently refreshed available provider model.
                    </p>
                  </div>
                  <label className={styles.field} htmlFor="openai-capability-model">
                    <span>Provider model to verify</span>
                    <select
                      id="openai-capability-model"
                      data-testid="openai-capability-model"
                      value={capabilityTargetId}
                      onChange={(event) => {
                        setCapabilityModelId(event.target.value);
                        setCapabilityAttested(false);
                      }}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id} disabled={!model.available}>
                          {model.id} · OpenAI · {model.capabilitySource}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ToggleField
                    label="I attest that I verified this model against current authoritative provider documentation."
                    detail="Changing these values can enable provider capabilities and activation."
                    testId="openai-capability-attestation"
                    checked={capabilityAttested}
                    disabled={!capabilityTarget?.available}
                    onChange={setCapabilityAttested}
                  />
                  <div className={styles.capabilityGrid}>
                    {capabilityNames.map((name) => {
                      const explicit = explicitCapabilityOverrides[name];
                      const value =
                        explicit === true ? "true" : explicit === false ? "false" : "unknown";
                      const observed = capabilityTarget?.capabilities[name] ?? "unknown";
                      return (
                        <label
                          className={styles.field}
                          key={name}
                          htmlFor={`openai-capability-${name}`}
                        >
                          <span>{name}</span>
                          <select
                            id={`openai-capability-${name}`}
                            data-testid={`openai-capability-${name}`}
                            value={value}
                            disabled={!capabilityAttested || !capabilityTarget?.available}
                            onChange={(event) =>
                              updateCapabilityOverride(
                                capabilityTargetId,
                                name,
                                event.target.value as "unknown" | "true" | "false",
                              )
                            }
                          >
                            <option value="unknown">Unknown / not attested</option>
                            <option value="true">Verified supported</option>
                            <option value="false">Verified unsupported</option>
                          </select>
                          <small>Provider/cache observation: {String(observed)}</small>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}
            <div className="bea-cluster">
              <Button
                size="small"
                type="button"
                variant="secondary"
                data-testid="openai-test-connection"
                disabled={
                  !hydrated || Boolean(busy) || administration.apiKeyStatus !== "configured"
                }
                onClick={() => void testConnection()}
              >
                {busy === "test" ? "Testing…" : "Test connection"}
              </Button>
              <Button
                size="small"
                type="button"
                variant="ghost"
                data-testid="openai-refresh-models"
                disabled={
                  !hydrated || Boolean(busy) || administration.apiKeyStatus !== "configured"
                }
                onClick={() => void refreshModels()}
              >
                {busy === "models" ? "Refreshing…" : "Refresh models"}
              </Button>
            </div>
          </AdministrationSection>

          <AdministrationSection
            title="Choose models"
            summary="Recommended models for executive conversation, research, and voice"
            open
          >
            <div className={styles.routingHeader}>
              <div>
                <strong>Owner model routing</strong>
                <p>
                  Discovered compatible models are shown. Use recommended models or change a route
                  before saving.
                </p>
              </div>
              <Button
                type="button"
                size="small"
                variant="secondary"
                data-testid="openai-reset-route-recommendations"
                disabled={Boolean(busy)}
                onClick={resetRoutesToRecommendations}
              >
                Use recommended models
              </Button>
              <Button
                type="button"
                size="small"
                variant="secondary"
                data-testid="openai-verify-selected-models"
                disabled={
                  !hydrated || Boolean(busy) || administration.apiKeyStatus !== "configured"
                }
                onClick={() => void verifySelectedModels()}
              >
                {busy === "models" ? "Verifying…" : "Verify selected models"}
              </Button>
            </div>
            <div className={styles.ownerRoutes} data-testid="openai-owner-routes">
              {OWNER_PRIMARY_WORKLOAD_ROUTES.map((routeKey) => {
                const route = settings.routingProfile.routes[routeKey];
                const assessment = routeCapabilityAssessment(
                  route,
                  models,
                  settings.modelCapabilityOverrides,
                );
                return (
                  <div key={routeKey} data-testid={`openai-owner-route-${routeKey}`}>
                    <ModelField
                      id={`openai-owner-${routeKey}`}
                      label={AI_ROUTE_PROFILE_LABELS[routeKey].profileLabel}
                      models={models}
                      purpose={routeKey === "realtime_voice" ? "realtime" : "text"}
                      value={route.primaryModel}
                      capabilityOverrides={settings.modelCapabilityOverrides}
                      onChange={(value) =>
                        updateRoute(routeKey, { primaryModel: value, enabled: Boolean(value) })
                      }
                    />
                    <small>
                      {AI_ROUTE_PROFILE_LABELS[routeKey].description} · cost {route.costClass} ·{" "}
                      {assessment.detail}
                      {administration.progressiveActivation?.routes?.find(
                        (item) => item.routeKey === routeKey,
                      )
                        ? ` · ${administration.progressiveActivation.routes.find((item) => item.routeKey === routeKey)?.reason}`
                        : ""}
                      {route.fallbackModel ? ` · fallback ${route.fallbackModel}` : ""}
                    </small>
                  </div>
                );
              })}
            </div>
            <div className={styles.stepActions}>
              <Button
                type="button"
                data-testid="openai-save-routing"
                disabled={!hydrated || Boolean(busy)}
                onClick={() => void saveSettings()}
              >
                {busy === "save" ? "Saving…" : "Save model routing"}
              </Button>
            </div>
            <div className={styles.ownerRoutes} data-testid="openai-owner-capabilities">
              <strong>Enable capabilities</strong>
              <ToggleField
                label="Web Search"
                detail="Use authorized public web search when the research model supports it."
                checked={settings.webSearchAllowed && settings.webSearchDefault}
                testId="openai-owner-web-search"
                onChange={(value) => {
                  update("webSearchAllowed", value);
                  update("webSearchDefault", value);
                }}
              />
              <ToggleField
                label="Speak Responses"
                detail="Spoken replies for Voice Mode. The microphone stays off until you start voice."
                checked={administration.voicePreference?.speakResponses !== false}
                testId="openai-owner-speak-responses"
                disabled={Boolean(busy)}
                onChange={(value) => void updateSpeakResponses(value)}
              />
              <ToggleField
                label="Realtime Voice"
                detail="Allow a live OpenAI Realtime session after a compatible voice model is selected."
                checked={settings.realtimeAllowed}
                testId="openai-owner-realtime"
                disabled={Boolean(modelCapabilityWarning(selectedRealtimeModel, "realtime"))}
                onChange={(value) => update("realtimeAllowed", value)}
              />
              <div className={styles.stepActions}>
                <Button
                  type="button"
                  data-testid="openai-save-capabilities"
                  disabled={!hydrated || Boolean(busy)}
                  onClick={() => void saveSettings()}
                >
                  {busy === "save" ? "Saving…" : "Save capabilities"}
                </Button>
              </div>
            </div>
            <details className={styles.advanced} data-testid="openai-advanced-routes">
              <summary>Advanced 12-route matrix</summary>
              {compact ? (
                <div className={styles.compactRouteList} data-testid="openai-compact-route-list">
                  {routeEntries.map(([routeKey, route]) => {
                    const assessment = routeCapabilityAssessment(
                      route,
                      models,
                      settings.modelCapabilityOverrides,
                    );
                    return (
                      <div key={routeKey} data-testid={`openai-route-${routeKey}`}>
                        <span>
                          <strong>{workloadLabels[routeKey]}</strong>
                          <small>
                            {AI_ROUTE_PROFILE_LABELS[routeKey].profileLabel}
                            {" · "}
                            {route.primaryModel ?? "Unassigned"}
                            {" · cost "}
                            {route.costClass}
                          </small>
                        </span>
                        <Badge tone={assessment.status === "ready" ? "success" : "warning"}>
                          {assessment.status.toUpperCase()}
                        </Badge>
                      </div>
                    );
                  })}
                  <small>
                    Review advanced fallbacks, tools, per-route tests, and capability attestations
                    in restricted administration.
                  </small>
                </div>
              ) : (
                <div className={styles.routingTableScroll}>
                  <table className={styles.routingTable} aria-label="OpenAI workload routing">
                    <thead>
                      <tr>
                        <th scope="col">Enabled</th>
                        <th scope="col">Workload</th>
                        <th scope="col">Primary</th>
                        <th scope="col">Fallback</th>
                        <th scope="col">Tools</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeEntries.map(([routeKey, route]) => {
                        const assessment = routeCapabilityAssessment(
                          route,
                          models,
                          settings.modelCapabilityOverrides,
                        );
                        const primaryOptions = modelOptionsWithCurrent(models, route.primaryModel);
                        const fallbackOptions = modelOptionsWithCurrent(
                          models,
                          route.fallbackModel,
                        );
                        return (
                          <tr key={routeKey} data-testid={`openai-route-${routeKey}`}>
                            <td>
                              <label className={styles.routeToggle}>
                                <input
                                  type="checkbox"
                                  checked={route.enabled}
                                  aria-label={`Enable ${workloadLabels[routeKey]}`}
                                  onChange={(event) =>
                                    updateRoute(routeKey, { enabled: event.target.checked })
                                  }
                                />
                                <span>{route.enabled ? "On" : "Off"}</span>
                              </label>
                            </td>
                            <th scope="row">
                              <span>{workloadLabels[routeKey]}</span>
                              <small data-testid={`openai-route-profile-${routeKey}`}>
                                {AI_ROUTE_PROFILE_LABELS[routeKey].profileLabel}
                                {" · cost "}
                                {route.costClass}
                              </small>
                              <details className={styles.routeAdvanced}>
                                <summary>Advanced route options</summary>
                                <div>
                                  <label htmlFor={`openai-route-reasoning-${routeKey}`}>
                                    Reasoning
                                    <select
                                      id={`openai-route-reasoning-${routeKey}`}
                                      value={route.reasoningEffort}
                                      onChange={(event) =>
                                        updateRoute(routeKey, {
                                          reasoningEffort: event.target
                                            .value as AiModelRoutePolicy["reasoningEffort"],
                                        })
                                      }
                                    >
                                      <option value="none">None</option>
                                      <option value="low">Low</option>
                                      <option value="medium">Medium</option>
                                      <option value="high">High</option>
                                    </select>
                                  </label>
                                  <label htmlFor={`openai-route-tokens-${routeKey}`}>
                                    Max output tokens
                                    <input
                                      id={`openai-route-tokens-${routeKey}`}
                                      type="number"
                                      min={1}
                                      max={128_000}
                                      value={route.maxOutputTokens}
                                      onChange={(event) => {
                                        const value = Number(event.target.value);
                                        if (Number.isFinite(value)) {
                                          updateRoute(routeKey, { maxOutputTokens: value });
                                        }
                                      }}
                                    />
                                  </label>
                                  <label htmlFor={`openai-route-timeout-${routeKey}`}>
                                    Timeout (ms)
                                    <input
                                      id={`openai-route-timeout-${routeKey}`}
                                      type="number"
                                      min={1_000}
                                      max={600_000}
                                      step={1_000}
                                      value={route.timeoutMs}
                                      onChange={(event) => {
                                        const value = Number(event.target.value);
                                        if (Number.isFinite(value)) {
                                          updateRoute(routeKey, { timeoutMs: value });
                                        }
                                      }}
                                    />
                                  </label>
                                  <small>Required: {route.requiredCapabilities.join(", ")}</small>
                                  <small>Cost class: {route.costClass}</small>
                                </div>
                              </details>
                            </th>
                            <td>
                              <label className={styles.routeSelect}>
                                <select
                                  value={route.primaryModel ?? ""}
                                  aria-label={`Primary model for ${workloadLabels[routeKey]}`}
                                  onChange={(event) =>
                                    updateRoute(routeKey, {
                                      primaryModel: event.target.value || null,
                                    })
                                  }
                                >
                                  <option value="">Unassigned</option>
                                  {primaryOptions.map((model) => (
                                    <option key={model.id} value={model.id}>
                                      {model.id}
                                      {model.available ? "" : " · unavailable"}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </td>
                            <td>
                              <label className={styles.routeSelect}>
                                <select
                                  value={route.fallbackModel ?? ""}
                                  aria-label={`Fallback model for ${workloadLabels[routeKey]}`}
                                  onChange={(event) =>
                                    updateRoute(routeKey, {
                                      fallbackModel: event.target.value || null,
                                    })
                                  }
                                >
                                  <option value="">None</option>
                                  {fallbackOptions.map((model) => (
                                    <option key={model.id} value={model.id}>
                                      {model.id}
                                      {model.available ? "" : " · unavailable"}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </td>
                            <td>
                              <span className={styles.toolList}>
                                {route.toolAllowlist.length > 0
                                  ? route.toolAllowlist.join(", ")
                                  : "None"}
                              </span>
                            </td>
                            <td>
                              <Badge tone={assessment.status === "ready" ? "success" : "warning"}>
                                {assessment.status.toUpperCase()}
                              </Badge>
                              <small
                                className={
                                  assessment.status === "ready" ? styles.verified : styles.warning
                                }
                                data-testid={`openai-route-status-${routeKey}`}
                              >
                                {assessment.detail}
                              </small>
                              {routeTestResults[routeKey] ? (
                                <small data-testid={`openai-route-test-result-${routeKey}`}>
                                  {routeTestResults[routeKey]}
                                </small>
                              ) : null}
                              <Button
                                type="button"
                                size="small"
                                variant="ghost"
                                data-testid={`openai-test-route-${routeKey}`}
                                disabled={Boolean(busy) || Boolean(testingRoute) || !route.enabled}
                                onClick={() => void testRouteConfiguration(routeKey)}
                              >
                                {testingRoute === routeKey
                                  ? "Testing saved route…"
                                  : "Test saved route"}
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
            {administration.liveConnected ? (
              <p data-testid="openai-ready-status">
                OpenAI connected.{" "}
                <Link href="/ai-command" prefetch={false}>
                  Go to AI Command
                </Link>
              </p>
            ) : null}
          </AdministrationSection>

          {!compact ? (
            <>
              <AdministrationSection
                title="File Search knowledge sources"
                summary="Strict vector-store assignments saved with the routing profile"
              >
                <Alert tone="info" title="Assignment boundary">
                  Enter an existing OpenAI vector store ID. This screen assigns access to File
                  Search; it does not create, upload, delete, or inspect vector-store content.
                </Alert>
                <div className={styles.vectorStoreComposer}>
                  <label className={styles.field} htmlFor="openai-vector-store-id">
                    <span>Vector store ID</span>
                    <input
                      id="openai-vector-store-id"
                      data-testid="openai-vector-store-id"
                      value={vectorStoreId}
                      maxLength={131}
                      placeholder="vs_..."
                      aria-invalid={
                        Boolean(vectorStoreId) && !vectorStoreIdPattern.test(vectorStoreId)
                      }
                      onChange={(event) => setVectorStoreId(event.target.value)}
                    />
                    <small>Required format: vs_ followed by a provider identifier.</small>
                  </label>
                  <label className={styles.field} htmlFor="openai-vector-store-name">
                    <span>Display name</span>
                    <input
                      id="openai-vector-store-name"
                      data-testid="openai-vector-store-name"
                      value={vectorStoreName}
                      maxLength={120}
                      placeholder="Operations knowledge"
                      onChange={(event) => setVectorStoreName(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    data-testid="openai-add-vector-store"
                    disabled={!vectorStoreId.trim() || Boolean(busy)}
                    onClick={addVectorStoreAssignment}
                  >
                    Add assignment
                  </Button>
                </div>
                <div className={styles.vectorStoreList} data-testid="openai-vector-store-list">
                  {settings.routingProfile.vectorStoreAssignments.length === 0 ? (
                    <p>
                      No vector stores are assigned. Organizational File Search remains
                      unconfigured.
                    </p>
                  ) : (
                    settings.routingProfile.vectorStoreAssignments.map((assignment) => (
                      <div key={assignment.vectorStoreId}>
                        <ToggleField
                          label={assignment.displayName}
                          detail={`${assignment.vectorStoreId} · roles: ${assignment.allowedRoleKeys.join(", ")}`}
                          checked={assignment.enabled}
                          onChange={(enabled) =>
                            updateVectorStoreAssignment(assignment.vectorStoreId, { enabled })
                          }
                        />
                        <Button
                          type="button"
                          size="small"
                          variant="ghost"
                          onClick={() => removeVectorStoreAssignment(assignment.vectorStoreId)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))
                  )}
                </div>
                <small>
                  Server-reported saved IDs:{" "}
                  {(administration.vectorStoreIds ?? []).join(", ") || "none"}. File Search requires
                  both an enabled assignment and a compatible enabled route.
                </small>
              </AdministrationSection>

              <AdministrationSection
                title="Tools and generated artifacts"
                summary="Explicit allowlists; model-bound provider tools remain disabled when unverified"
              >
                <div className={styles.toggleGrid}>
                  <ToggleField
                    label="Web search"
                    detail="Allow grounded provider web search when the selected text model verifies support."
                    checked={settings.webSearchAllowed}
                    disabled={!toolCapability("webSearch")}
                    onChange={(value) => update("webSearchAllowed", value)}
                  />
                  <ToggleField
                    label="Default web search on"
                    checked={settings.webSearchDefault}
                    disabled={!settings.webSearchAllowed || !toolCapability("webSearch")}
                    onChange={(value) => update("webSearchDefault", value)}
                  />
                  <ToggleField
                    label="Code analysis"
                    detail="Allow the provider Code Interpreter only after capability verification."
                    checked={settings.codeInterpreterAllowed}
                    disabled={!toolCapability("codeInterpreter")}
                    onChange={(value) => update("codeInterpreterAllowed", value)}
                  />
                  <ToggleField
                    label="Image generation"
                    detail={
                      settings.highCostConfirmationThresholdUsd === null
                        ? "AI Command requires explicit intent and cost confirmation; provider dollar estimation is unavailable."
                        : `${settings.highCostConfirmationThresholdUsd.toLocaleString("en-US", { style: "currency", currency: "USD" })} is stored as a policy target. Because provider dollar estimation is unavailable, AI Command conservatively requires confirmation for every high-cost tool.`
                    }
                    checked={settings.imageGenerationAllowed}
                    disabled={!toolCapability("imageGeneration")}
                    onChange={(value) => update("imageGenerationAllowed", value)}
                  />
                  <ToggleField
                    label="PDF generation"
                    detail="Uses the registered BEA application renderer, not paid image generation."
                    checked={settings.pdfGenerationAllowed}
                    onChange={(value) => update("pdfGenerationAllowed", value)}
                  />
                  <ToggleField
                    label="Realtime session seam"
                    detail={
                      modelCapabilityWarning(selectedRealtimeModel, "realtime") ??
                      "Realtime and audio capabilities verified."
                    }
                    checked={settings.realtimeAllowed}
                    disabled={
                      settings.mode !== "demo" &&
                      Boolean(modelCapabilityWarning(selectedRealtimeModel, "realtime"))
                    }
                    onChange={(value) => update("realtimeAllowed", value)}
                  />
                </div>
              </AdministrationSection>

              <AdministrationSection
                title="Usage, files, retention, and cost"
                summary="Bounded request, upload, generation, retention, and commercial guardrails"
              >
                <Alert tone="warning" title="Live activation is chargeable">
                  Connecting OpenAI, discovering models, streaming text, public web search, and
                  Realtime voice consume the owner project quota. Disconnected providers fail
                  closed. Rate limits below are application-owned ceilings, not a billing waiver.
                </Alert>
                <div className={styles.fieldGrid}>
                  <NumericField
                    id="openai-request-timeout"
                    label="Request timeout"
                    value={settings.requestTimeoutMs}
                    min={1_000}
                    max={120_000}
                    step={1_000}
                    suffix="ms"
                    onChange={(value) => value !== null && update("requestTimeoutMs", value)}
                  />
                  <NumericField
                    id="openai-daily-request-limit"
                    label="Daily request limit"
                    value={settings.dailyRequestLimit}
                    min={1}
                    max={100_000}
                    onChange={(value) => value !== null && update("dailyRequestLimit", value)}
                  />
                  <NumericField
                    id="openai-user-rate-limit"
                    label="Per-user requests"
                    value={settings.perUserRequestsPerMinute}
                    min={1}
                    max={1_000}
                    suffix="per minute"
                    onChange={(value) =>
                      value !== null && update("perUserRequestsPerMinute", value)
                    }
                  />
                  <NumericField
                    id="openai-conversation-rate-limit"
                    label="Per-conversation requests"
                    value={settings.perConversationRequestsPerMinute}
                    min={1}
                    max={1_000}
                    suffix="per minute"
                    onChange={(value) =>
                      value !== null && update("perConversationRequestsPerMinute", value)
                    }
                  />
                  <NumericField
                    id="openai-upload-limit"
                    label="Restricted upload limit"
                    value={Math.round(settings.maxUploadBytes / 1_000_000)}
                    min={1}
                    max={12}
                    suffix="MB"
                    onChange={(value) =>
                      value !== null && update("maxUploadBytes", Math.round(value * 1_000_000))
                    }
                  />
                  <NumericField
                    id="openai-generated-file-limit"
                    label="Generated file limit"
                    value={Math.round(settings.maxGeneratedFileBytes / 1_000_000)}
                    min={1}
                    max={100}
                    suffix="MB"
                    onChange={(value) =>
                      value !== null &&
                      update("maxGeneratedFileBytes", Math.round(value * 1_000_000))
                    }
                  />
                  <NumericField
                    id="openai-artifact-retention"
                    label="Artifact retention"
                    value={settings.artifactRetentionDays}
                    min={1}
                    max={90}
                    suffix="days"
                    onChange={(value) => value !== null && update("artifactRetentionDays", value)}
                  />
                  <NumericField
                    id="openai-research-duration"
                    label="Research duration limit"
                    value={settings.maxResearchDurationSeconds}
                    min={10}
                    max={3_600}
                    suffix="seconds"
                    onChange={(value) =>
                      value !== null && update("maxResearchDurationSeconds", value)
                    }
                  />
                  <NumericField
                    id="openai-code-duration"
                    label="Code container limit"
                    value={settings.codeInterpreterMaxContainerSeconds}
                    min={10}
                    max={3_600}
                    suffix="seconds"
                    onChange={(value) =>
                      value !== null && update("codeInterpreterMaxContainerSeconds", value)
                    }
                  />
                  <NumericField
                    id="openai-monthly-cost-limit"
                    label="Monthly cost seam"
                    value={settings.monthlyCostLimitUsd}
                    min={0}
                    max={1_000_000}
                    step={0.01}
                    suffix="USD; blank means unavailable"
                    nullable
                    onChange={(value) => update("monthlyCostLimitUsd", value)}
                  />
                  <NumericField
                    id="openai-high-cost-threshold"
                    label="High-cost confirmation threshold"
                    value={settings.highCostConfirmationThresholdUsd}
                    min={0}
                    max={1_000_000}
                    step={0.01}
                    suffix="USD policy target; blank disables the target"
                    nullable
                    onChange={(value) => update("highCostConfirmationThresholdUsd", value)}
                  />
                </div>
                <label className={styles.field} htmlFor="openai-image-quality">
                  <span>Image quality</span>
                  <select
                    id="openai-image-quality"
                    value={settings.imageQuality}
                    onChange={(event) =>
                      update(
                        "imageQuality",
                        event.target.value as AiProviderSettings["imageQuality"],
                      )
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
              </AdministrationSection>

              <AdministrationSection
                title="Realtime behavior"
                summary="Saved voice-session policy only; browser microphone and WebRTC are not activated"
              >
                <Alert tone="warning" title="Live browser voice remains blocked">
                  This administration page saves policy only. It does not request microphone access,
                  create a WebRTC connection, or request a client authorization.
                </Alert>
                <div
                  className={styles.preferenceStatus}
                  data-testid="openai-speak-responses-status"
                >
                  <div>
                    <strong>Speak responses by default</strong>
                    <small>
                      Read-only per-user preference. This provider settings form does not mutate it.
                    </small>
                  </div>
                  <Badge tone={administration.voicePreference?.speakResponses ? "success" : "info"}>
                    {administration.voicePreference
                      ? administration.voicePreference.speakResponses
                        ? "ON"
                        : "OFF"
                      : "NOT CONFIGURED"}
                  </Badge>
                </div>
                <div className={styles.fieldGrid}>
                  <label className={styles.field} htmlFor="openai-turn-detection">
                    <span>Turn detection</span>
                    <select
                      id="openai-turn-detection"
                      value={settings.realtimeTurnDetection}
                      onChange={(event) =>
                        update(
                          "realtimeTurnDetection",
                          event.target.value as AiProviderSettings["realtimeTurnDetection"],
                        )
                      }
                    >
                      <option value="server_vad">Server VAD</option>
                      <option value="semantic_vad">Semantic VAD</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor="openai-interaction-mode">
                    <span>Interaction mode</span>
                    <select
                      id="openai-interaction-mode"
                      value={settings.realtimeInteractionMode}
                      onChange={(event) =>
                        update(
                          "realtimeInteractionMode",
                          event.target.value as AiProviderSettings["realtimeInteractionMode"],
                        )
                      }
                    >
                      <option value="automatic">Automatic</option>
                      <option value="push_to_talk">Push to talk</option>
                    </select>
                  </label>
                  <NumericField
                    id="openai-output-speed"
                    label="Output speed"
                    value={settings.realtimeOutputSpeed}
                    min={0.25}
                    max={1.5}
                    step={0.05}
                    onChange={(value) => value !== null && update("realtimeOutputSpeed", value)}
                  />
                  <NumericField
                    id="openai-realtime-token-limit"
                    label="Realtime output limit"
                    value={settings.realtimeMaxOutputTokens}
                    min={1}
                    max={4_096}
                    suffix="tokens"
                    onChange={(value) => value !== null && update("realtimeMaxOutputTokens", value)}
                  />
                </div>
                <ToggleField
                  label="Allow interruption"
                  checked={settings.realtimeAllowInterruption}
                  onChange={(value) => update("realtimeAllowInterruption", value)}
                />
                <label className={styles.field} htmlFor="openai-session-instructions">
                  <span>Realtime session instructions</span>
                  <textarea
                    id="openai-session-instructions"
                    className="bea-textarea"
                    maxLength={4_000}
                    value={settings.realtimeSessionInstructions}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                      update("realtimeSessionInstructions", event.target.value)
                    }
                  />
                </label>
              </AdministrationSection>
            </>
          ) : null}

          <div className={styles.footerActions}>
            <Button
              type="submit"
              data-testid="openai-save-settings"
              disabled={!hydrated || Boolean(busy)}
            >
              {busy === "save" ? "Saving…" : "Save settings"}
            </Button>
            <small>
              Model routing, voice, and capability settings save here. The API key connects from the
              key field above.
            </small>
          </div>
        </form>
      </CardContent>
      <ConfirmationDialog
        open={confirmDisconnect}
        title="Disconnect OpenAI?"
        description="This disables live OpenAI, invalidates prior connection evidence, and securely deletes the Windows-protected key. OpenAI Command will fail closed until you connect again."
        confirmLabel="Disconnect and delete protected key"
        busy={busy === "disconnect"}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
      />
    </Card>
  );
}
