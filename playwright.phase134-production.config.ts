import { createBeaPlaywrightConfig } from "./playwright.shared";

// Exact-authority TEST-ONLY presentation profile. It intentionally reuses the
// Phase 1.3.3 server guard, cannot access protected production secrets, and is
// not evidence of trusted machine HTTPS, real PostgreSQL, or a live provider.
export default createBeaPlaywrightConfig({
  browserMediaTestMode: false,
  productionPresentationTestMode: true,
});
