import { CommercialInputError, commercialJson } from "./cpl-commercial-http";

/** Only bounded application codes cross this boundary; provider/SQL messages do not. */
export function administrationFailure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (
    !/^CPL_(?:ADMIN_[A-Z_]+|COMPANY_[A-Z_]+|DIRECTORY_[A-Z_]+|CATALOG_[A-Z_]+|INTAKE_[A-Z_]+|INVALID_INPUT|INVALID_IDEMPOTENCY_KEY|ACCESS_DENIED|SESSION_REQUIRED|AUTHENTICATION_REQUIRED|CSRF_REJECTED|ORGANIZATION_(?:REQUIRED|CONTEXT_CHANGED|ACCESS_DENIED|SLUG_UNAVAILABLE)|PLATFORM_[A-Z_]+|RECENT_MFA_REQUIRED|LOCAL_DEVELOPMENT_REFUSED|LAST_ACTIVE_OWNER|MEMBER_(?:NOT_FOUND|ALREADY_EXISTS)|INVITATION_(?:UNAVAILABLE|ALREADY_EXISTS)|INITIAL_OWNER_MUST_BE_DISTINCT|MODULE_DISABLED|RECORD_NOT_FOUND|IDEMPOTENCY_CONFLICT)$/u.test(
      code,
    )
  )
    return commercialJson({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status = code.endsWith("NOT_FOUND")
    ? 404
    : ["CPL_SESSION_REQUIRED", "CPL_AUTHENTICATION_REQUIRED"].includes(code)
      ? 401
      : code.includes("SCHEMA") || code === "CPL_LOCAL_DEVELOPMENT_REFUSED"
        ? 503
        : code.includes("INVALID") || code === "CPL_INITIAL_OWNER_MUST_BE_DISTINCT"
          ? 400
          : /(?:CONFLICT|STALE|CHANGED|ALREADY_EXISTS|DUPLICATE|IMMUTABLE|LAST_ACTIVE_OWNER|SLUG_UNAVAILABLE|IN_USE|ARCHIVED)/u.test(
                code,
              )
            ? 409
            : 403;
  return commercialJson({ code }, status);
}

/** No ignored query claims, duplicate parameters or unbounded list sizes. */
export function administrationQuery(request: Request, keys: readonly string[]) {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys())
    if (!keys.includes(key) || parameters.getAll(key).length !== 1)
      throw new CommercialInputError();
  const value: Record<string, string> = {};
  for (const [key, item] of parameters) {
    if (item.length > 2048) throw new CommercialInputError();
    value[key] = item;
  }
  return value;
}
export function administrationList(request: Request) {
  const query = administrationQuery(request, ["query", "status", "cursor", "limit"]);
  if (query.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/u.test(query.limit))
    throw new CommercialInputError();
  return { ...query, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) };
}
