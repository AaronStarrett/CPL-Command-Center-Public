import "server-only";

import { getServerRuntime } from "@bea/database";
import { createCorrelationId } from "@bea/observability";
import type { Permission } from "@bea/security";
import { redirect } from "next/navigation";

import { getCurrentSession } from "./session-store";
import { hasDemoSessionCookie } from "./session-store";

export async function requireSession() {
  const session = await getCurrentSession();
  if (!session) {
    const runtime = await getServerRuntime();
    const correlationId = createCorrelationId();
    const hadCookie = await hasDemoSessionCookie();
    await runtime.repository.record({
      eventType: "authentication.required",
      action: "session.require",
      outcome: "denied",
      correlationId,
      metadata: { reason: hadCookie ? "expired-or-invalid" : "missing" },
    });
    runtime.logger.warn(
      { correlationId, reason: hadCookie ? "expired-or-invalid" : "missing" },
      "Authenticated page request denied",
    );
    redirect(`/sign-in?reason=${hadCookie ? "expired" : "required"}`);
  }
  return session;
}

export async function requirePermission(permission: Permission, resource: string) {
  return requireAnyPermission([permission], resource);
}

export async function requireAnyPermission(permissions: readonly Permission[], resource: string) {
  const session = await requireSession();
  const runtime = await getServerRuntime();
  const correlationId = createCorrelationId();
  const decisions = await Promise.all(
    permissions.map((permission) =>
      runtime.authorization.authorizeUser(session.personaId, permission),
    ),
  );
  const denied = decisions.find((decision) => !decision.allowed);
  if (!decisions.some((decision) => decision.allowed)) {
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: "route.access",
      outcome: "denied",
      actorUserId: session.personaId,
      resourceType: resource,
      correlationId,
      metadata: {
        permission: permissions[0],
        reason: denied && !denied.allowed ? denied.reason : "permission-not-granted",
      },
    });
    runtime.logger.warn(
      { correlationId, userId: session.personaId, permission: permissions[0], resource },
      "Authenticated page permission denied",
    );
    redirect(`/access-denied?resource=${encodeURIComponent(resource)}`);
  }
  return session;
}
