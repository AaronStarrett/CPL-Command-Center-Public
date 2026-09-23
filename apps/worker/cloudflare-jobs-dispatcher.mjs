/** Only the explicitly selected transport is loaded. A failure never selects another. */
export function createHostedJobsDispatcher({
  loadLegacy = () => import("./cloudflare-scheduler.mjs"),
  loadHttp = () => import("./cloudflare-neon-scheduler.mjs"),
} = {}) {
  let legacy, http;
  return async function scheduled(controller, environment) {
    const selected = environment.CPL_JOBS_TRANSPORT;
    if (selected === undefined || selected === "hyperdrive") {
      // Unset preserves the original scheduler's direct/local/Hyperdrive selection.
      if (selected === "hyperdrive" && environment.CPL_DATABASE_TRANSPORT !== "hyperdrive")
        throw new Error("CPL_HOSTED_JOBS_TRANSPORT_REFUSED");
      legacy ??= loadLegacy().then((module) => module.createHostedScheduledHandler());
      return (await legacy)(controller, environment);
    }
    if (selected === "neon-http") {
      http ??= loadHttp().then((module) => module.createNeonHttpScheduledHandler());
      return (await http)(controller, environment);
    }
    throw new Error("CPL_HOSTED_JOBS_TRANSPORT_REFUSED");
  };
}
