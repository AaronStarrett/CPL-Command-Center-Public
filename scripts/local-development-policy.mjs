/** Local fixture credentials must never be silently scrubbed into a successful
 * production build/deploy. Fail before configuration or artifact mutations. */
export function assertNoLocalDevelopmentConfiguration(source = process.env) {
  const keys = ["CPL_LOCAL_DEVELOPMENT_AUTH", "CPL_LOCAL_DATABASE_URL", "CPL_LOCAL_SESSION_SECRET"];
  if (keys.some((key) => source[key] !== undefined))
    throw new Error("CPL_LOCAL_DEVELOPMENT_PRODUCTION_REFUSED");
}
