import "server-only";

import { getServerRuntime } from "@bea/database";
import type { RoleId } from "@bea/domain";
import { LOCAL_OWNER_SESSION_COOKIE } from "@bea/security";
import { cookies } from "next/headers";

import { getDemoPersona } from "./personas";

export const DEMO_SESSION_COOKIE = "bea_session";

export type WebAuthenticationProvider = "demo" | "local-owner" | "microsoft-entra";

export interface AuthSession {
  provider: Exclude<WebAuthenticationProvider, "microsoft-entra">;
  personaId: string;
  personaKey: string;
  displayName: string;
  email: string | null;
  title: string;
  roleIds: readonly RoleId[];
  createdAt: string;
  expiresAt: string;
}

/** Compatibility name for authenticated pages; the record now covers Local Owner too. */
export type DemoSession = AuthSession;

export function sessionCookieName(provider: WebAuthenticationProvider): string | null {
  if (provider === "demo") return DEMO_SESSION_COOKIE;
  if (provider === "local-owner") return LOCAL_OWNER_SESSION_COOKIE;
  return null;
}

export async function getAuthenticationProvider(): Promise<WebAuthenticationProvider> {
  return (await getServerRuntime()).environment.authProvider;
}

export async function isDemoAuthEnabled(): Promise<boolean> {
  const runtime = await getServerRuntime();
  return runtime.authentication.kind === "demo" && runtime.environment.demoAuthEnabled;
}

export async function readAuthSession(token: string | undefined): Promise<AuthSession | undefined> {
  if (!token || token.length > 512) return undefined;
  const runtime = await getServerRuntime();
  if (runtime.authentication.kind === "microsoft-entra") return undefined;
  const authenticated = await runtime.authentication.readSession(token);
  if (!authenticated) return undefined;
  const { user, session } = authenticated;
  const configuredPersona =
    runtime.authentication.kind === "demo" ? getDemoPersona(user.id) : undefined;
  return {
    provider: runtime.authentication.kind,
    personaId: user.id,
    personaKey: user.personaKey ?? configuredPersona?.key ?? "",
    displayName: configuredPersona?.displayName ?? user.displayName,
    email: user.email || null,
    title: user.title ?? configuredPersona?.title ?? "Authenticated user",
    roleIds: user.roleIds,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

export async function readDemoSession(token: string | undefined): Promise<AuthSession | undefined> {
  const runtime = await getServerRuntime();
  if (runtime.authentication.kind !== "demo" || !runtime.environment.demoAuthEnabled) {
    return undefined;
  }
  return readAuthSession(token);
}

export async function getActiveDemoSessionCount(): Promise<number> {
  const runtime = await getServerRuntime();
  return runtime.repository.countActiveSessions();
}

export async function getCurrentSession(): Promise<AuthSession | undefined> {
  const runtime = await getServerRuntime();
  const name = sessionCookieName(runtime.environment.authProvider);
  if (!name) return undefined;
  const cookieStore = await cookies();
  return readAuthSession(cookieStore.get(name)?.value);
}

export async function hasDemoSessionCookie(): Promise<boolean> {
  const runtime = await getServerRuntime();
  const name = sessionCookieName(runtime.environment.authProvider);
  if (!name) return false;
  const cookieStore = await cookies();
  return cookieStore.has(name);
}
