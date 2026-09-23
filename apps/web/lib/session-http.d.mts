import type { CplHostedSession } from "@bea/security/hosted";
export const DEADLINE_SQL: string, READ_SQL: string, PASSKEY_SQL: string;
export interface SessionReader {
  readSession(hash: string, now: string): Promise<CplHostedSession | null>;
  readSessionWithPasskey(
    hash: string,
    now: string,
  ): Promise<{
    readonly session: CplHostedSession;
    readonly hasPasskey: boolean;
  } | null>;
  close(): void;
  status(): Readonly<{ state: string; requests: number }>;
}
export function mapSessionResult(passkey: false, results: unknown): CplHostedSession | null;
export function mapSessionResult(
  passkey: true,
  results: unknown,
): { readonly session: CplHostedSession; readonly hasPasskey: boolean } | null;
export function mapSessionResult<Passkey extends boolean>(
  passkey: Passkey,
  results: unknown,
):
  | (Passkey extends true
      ? { readonly session: CplHostedSession; readonly hasPasskey: boolean }
      : CplHostedSession)
  | null;
export function sessionReadTransport(value: unknown): "hyperdrive" | "neon-http";
export function createSessionTransport(configuration: {
  driver: unknown;
  version: "1.1.0";
  connectionString: string;
  policy: { host: string; database: string; role: "cpl_web_runtime" };
  fetchImplementation: typeof fetch;
}): { invocation(options?: { timeoutMs?: number }): SessionReader };
