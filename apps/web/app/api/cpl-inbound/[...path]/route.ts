import { SqlCplInboundRepository } from "@bea/database/hosted";
import { createCplIntegrationRuntime } from "@bea/database/cpl-integration-runtime";
import { withHostedRuntime } from "@/lib/hosted-auth";
import { administrationQuery } from "@/lib/cpl-administration-http";
import {
  inboundJson as json,
  inboundBytes,
  inboundPublicId,
  inboundAddressKey,
  requireInquiryOrigin,
  signedInboundHeaders,
} from "@/lib/cpl-inbound-http";
import { integrationFailure } from "@/lib/cpl-integration-http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    administrationQuery(request, []);
    if (path.length !== 2 || path[0] !== "forms")
      return json({ code: "CPL_INBOUND_UNAVAILABLE" }, 404);
    const publicId = inboundPublicId(path[1]);
    return await withHostedRuntime(
      async (runtime) => {
        const options = await createCplIntegrationRuntime({
          database: runtime.database,
          origin: runtime.origin,
        });
        return json(
          await new SqlCplInboundRepository(
            runtime.database,
            runtime.tenants,
            options,
          ).readPublicForm(publicId),
        );
      },
      { request },
    );
  } catch (error) {
    return integrationFailure(error, true);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    administrationQuery(request, []);
    if (path.length !== 2 || !["forms", "sources"].includes(path[0]!))
      return json({ code: "CPL_INBOUND_UNAVAILABLE" }, 404);
    const publicId = inboundPublicId(path[1]);
    if (path[0] === "forms") requireInquiryOrigin(request, process.env.APP_BASE_URL ?? "");
    const rawBody = await inboundBytes(request);
    return await withHostedRuntime(
      async (runtime) => {
        const options = await createCplIntegrationRuntime({
          database: runtime.database,
          origin: runtime.origin,
        });
        const repo = new SqlCplInboundRepository(runtime.database, runtime.tenants, options);
        const boundary = { publicId, rawBody, addressKey: inboundAddressKey(request) };
        if (path[0] === "forms") {
          requireInquiryOrigin(request, runtime.origin);
          return json(await repo.acceptSubmission({ ...boundary, source: "browser_form" }), 202);
        }
        return json(
          await repo.acceptSubmission({
            ...boundary,
            ...signedInboundHeaders(request),
            source: "signed_form",
          }),
          202,
        );
      },
      { request },
    );
  } catch (error) {
    return integrationFailure(error, true);
  }
}
