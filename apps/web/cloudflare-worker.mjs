import openNext from "./.open-next/worker.js";
import { runWithCloudflareRequestContext } from "./.open-next/cloudflare/init.js";
import { workspaceAsset } from "./.open-next/cpl-shell.mjs";
import { createCplWorkerFetch } from "./lib/cloudflare-dispatch.ts";
import * as session from "./app/api/auth/session/route.ts";
import * as googleStart from "./app/api/auth/google/start/route.ts";
import * as googleCallback from "./app/api/auth/google/callback/route.ts";
import * as renew from "./app/api/auth/renew/route.ts";
import * as logout from "./app/api/auth/logout/route.ts";
import * as registerOptions from "./app/api/auth/passkeys/register/options/route.ts";
import * as registerVerify from "./app/api/auth/passkeys/register/verify/route.ts";
import * as authenticateOptions from "./app/api/auth/passkeys/authenticate/options/route.ts";
import * as authenticateVerify from "./app/api/auth/passkeys/authenticate/verify/route.ts";
import * as cpl from "./app/api/cpl/[...path]/route.ts";

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";

const worker = {
  fetch: createCplWorkerFetch({
    auth: {
      "/api/auth/session": session,
      "/api/auth/google/start": googleStart,
      "/api/auth/google/callback": googleCallback,
      "/api/auth/renew": renew,
      "/api/auth/logout": logout,
      "/api/auth/passkeys/register/options": registerOptions,
      "/api/auth/passkeys/register/verify": registerVerify,
      "/api/auth/passkeys/authenticate/options": authenticateOptions,
      "/api/auth/passkeys/authenticate/verify": authenticateVerify,
    },
    cpl,
    workspaceAsset,
    runWithContext: runWithCloudflareRequestContext,
    fallback: (request, env, context) => openNext.fetch(request, env, context),
  }),
};

export default worker;
