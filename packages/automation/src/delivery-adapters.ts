import type { JsonObject } from "@bea/domain";
import { DeliveryNotConfirmedError } from "@bea/domain";

export interface DeliveryRequest {
  readonly idempotencyKey: string;
  readonly reportId: string;
  readonly reportVersionId: string;
  readonly reportReference: string;
  readonly artifactChecksum: string;
  readonly artifact: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly correlationId: string;
}

export interface DeliveryAdapterResult {
  readonly confirmed: true;
  readonly adapterKey: string;
  readonly externalMessageId: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly artifactChecksum: string;
  readonly deliveredAt: string;
  readonly synthetic: boolean;
}

export interface DeliveryAdapter {
  readonly key: string;
  readonly live: boolean;
  deliver(request: DeliveryRequest): Promise<DeliveryAdapterResult>;
}

export class DeliveryAdapterError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    readonly retryable: boolean,
    readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "DeliveryAdapterError";
    this.code = code;
  }
}

export class LocalTestDeliveryAdapter implements DeliveryAdapter {
  readonly key = "local-test";
  readonly live = false;
  private readonly sent = new Map<string, DeliveryAdapterResult>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async deliver(request: DeliveryRequest): Promise<DeliveryAdapterResult> {
    const existing = this.sent.get(request.idempotencyKey);
    if (existing) return existing;
    if (request.recipients.length === 0) {
      throw new DeliveryAdapterError(
        "DELIVERY_RECIPIENTS_REQUIRED",
        "Delivery requires at least one recipient.",
        false,
      );
    }
    const result: DeliveryAdapterResult = {
      confirmed: true,
      adapterKey: this.key,
      externalMessageId: `local-test:${request.idempotencyKey}`,
      recipients: request.recipients,
      subject: request.subject,
      artifactChecksum: request.artifactChecksum,
      deliveredAt: this.now().toISOString(),
      synthetic: true,
    };
    this.sent.set(request.idempotencyKey, result);
    return result;
  }

  get sentCount(): number {
    return this.sent.size;
  }
}

export class FailClosedLiveDeliveryAdapter implements DeliveryAdapter {
  readonly key = "live-fail-closed";
  readonly live = true;

  async deliver(): Promise<DeliveryAdapterResult> {
    throw new DeliveryAdapterError(
      "LIVE_DELIVERY_NOT_CONFIGURED",
      "Live delivery is fail-closed until an authorized connector is configured, authenticated, and activated.",
      false,
      { liveConnection: "NOT RUN" },
    );
  }
}

export class ScriptedDeliveryAdapter implements DeliveryAdapter {
  readonly key: string;
  readonly live = false;
  private attempts = 0;
  private readonly sent = new Set<string>();

  constructor(
    private readonly failForAttempts: number,
    key = "scripted-test",
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = key;
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryAdapterResult> {
    this.attempts += 1;
    if (this.attempts <= this.failForAttempts) {
      throw new DeliveryAdapterError(
        "DELIVERY_PROVIDER_UNAVAILABLE",
        "Scripted delivery adapter failed.",
        true,
        { attempt: this.attempts },
      );
    }
    if (this.sent.has(request.idempotencyKey)) {
      return {
        confirmed: true,
        adapterKey: this.key,
        externalMessageId: `scripted:${request.idempotencyKey}`,
        recipients: request.recipients,
        subject: request.subject,
        artifactChecksum: request.artifactChecksum,
        deliveredAt: this.now().toISOString(),
        synthetic: true,
      };
    }
    this.sent.add(request.idempotencyKey);
    return {
      confirmed: true,
      adapterKey: this.key,
      externalMessageId: `scripted:${request.idempotencyKey}`,
      recipients: request.recipients,
      subject: request.subject,
      artifactChecksum: request.artifactChecksum,
      deliveredAt: this.now().toISOString(),
      synthetic: true,
    };
  }

  get attemptCount(): number {
    return this.attempts;
  }

  get uniqueDeliveries(): number {
    return this.sent.size;
  }
}

export function assertDeliveryConfirmed(result: DeliveryAdapterResult): DeliveryAdapterResult {
  if (!result.confirmed || !result.externalMessageId) {
    throw new DeliveryNotConfirmedError();
  }
  return result;
}
