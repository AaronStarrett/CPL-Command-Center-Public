import { createHostedScheduledHandler } from "./cloudflare-scheduler.mjs";

export default {
  scheduled: createHostedScheduledHandler(),
  fetch() {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },
};
