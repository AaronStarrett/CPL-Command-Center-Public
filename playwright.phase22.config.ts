import { createBeaPlaywrightConfig } from "./playwright.shared";

export default createBeaPlaywrightConfig({
  browserMediaTestMode: false,
  phase22CopresenterTestMode: true,
});
