import { createBeaPlaywrightConfig } from "./playwright.shared";

export default createBeaPlaywrightConfig({
  browserMediaTestMode: false,
  phase34aGuidedExperienceTestMode: true,
});
