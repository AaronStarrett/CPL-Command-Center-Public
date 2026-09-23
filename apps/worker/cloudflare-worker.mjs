import { createHostedJobsDispatcher } from "./cloudflare-jobs-dispatcher.mjs";

export default {
  scheduled: createHostedJobsDispatcher(),
  fetch() {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },
};
