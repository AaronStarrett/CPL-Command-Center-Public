import { SqlCplAdministrationRepository } from "@bea/database/hosted";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  commercialTenant,
  commercialJson as json,
  commercialBody as body,
  commercialString as text,
} from "@/lib/cpl-commercial-http";
import {
  administrationFailure,
  administrationList,
  administrationQuery,
} from "@/lib/cpl-administration-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request),
          repository = new SqlCplAdministrationRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "bootstrap") {
          administrationQuery(request, []);
          return json(
            await repository.bootstrap({
              sessionToken: current.sessionToken,
              organizationId: current.session.selectedOrganizationId,
            }),
          );
        }
        const tenant = commercialTenant(current, request),
          list = administrationList(request);
        if (path.length === 1 && path[0] === "members")
          return json(await repository.listMembers({ ...tenant, ...list }));
        if (path.length === 1 && path[0] === "invitations")
          return json(await repository.listInvitations({ ...tenant, ...list }));
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return administrationFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    administrationQuery(request, []);
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedMutation(runtime, request),
          repository = new SqlCplAdministrationRepository(runtime.tenants);
        if (path.join("/") === "platform/organizations") {
          const input = await body(
            request,
            ["slug", "displayName", "initialOwnerIdentityId", "enabledModules", "idempotencyKey"],
            16384,
          );
          return json(
            await repository.provisionOrganization({ sessionToken: current.sessionToken, input }),
            201,
          );
        }
        if (path.join("/") === "invitations/accept") {
          const input = await body(
            request,
            ["organizationId", "invitationToken", "idempotencyKey"],
            16384,
          );
          // A token's target is a lookup, not selected-tenant authority. The service
          // binds redemption to the signed-in verified identity and locked issuer.
          return json(
            await repository.acceptInvitation({
              sessionToken: current.sessionToken,
              organizationId: text(input, "organizationId"),
              invitationToken: text(input, "invitationToken"),
              idempotencyKey: text(input, "idempotencyKey"),
            }),
          );
        }
        const tenant = commercialTenant(current, request);
        if (path.length === 1 && path[0] === "members")
          return json(
            await repository.changeMember({
              ...tenant,
              input: await body(
                request,
                ["identityId", "role", "status", "expectedVersion", "reason", "idempotencyKey"],
                16384,
              ),
            }),
          );
        if (path.length === 1 && path[0] === "invitations")
          return json(
            await repository.createInvitation({
              ...tenant,
              input: await body(
                request,
                ["recipientIdentityId", "role", "expiresInMinutes", "idempotencyKey"],
                16384,
              ),
            }),
            201,
          );
        if (
          path.length === 3 &&
          path[0] === "invitations" &&
          ["reissue", "revoke"].includes(path[2]!)
        ) {
          const input = {
            ...(await body(request, ["expectedVersion", "reason", "idempotencyKey"], 16384)),
            invitationId: path[1]!,
          };
          return json(
            await (path[2] === "reissue"
              ? repository.reissueInvitation({ ...tenant, input })
              : repository.revokeInvitation({ ...tenant, input })),
          );
        }
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return administrationFailure(error);
  }
}
