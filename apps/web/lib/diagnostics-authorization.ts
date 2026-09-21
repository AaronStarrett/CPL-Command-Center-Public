import { PERMISSIONS, type Permission } from "@bea/security";

export interface DiagnosticsAuthorizationRuntime {
  readonly authorization: {
    authorizeUser(userId: string, permission: Permission): Promise<{ readonly allowed: boolean }>;
  };
}

export async function canIncludeApiDiagnostics(
  runtime: DiagnosticsAuthorizationRuntime | undefined,
  authenticatedUserId: string | undefined,
): Promise<boolean> {
  if (!runtime || !authenticatedUserId) return false;

  try {
    const decision = await runtime.authorization.authorizeUser(
      authenticatedUserId,
      PERMISSIONS.ADMINISTRATION_VIEW,
    );
    return decision.allowed;
  } catch {
    // Diagnostics are optional and must fail closed if authorization storage is unavailable.
    return false;
  }
}
