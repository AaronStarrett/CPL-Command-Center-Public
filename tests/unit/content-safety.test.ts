import { describe, expect, it } from "vitest";

import {
  containsCredentialLikeContent,
  requireCredentialSafeContent,
  SensitiveContentRejectedError,
} from "../../packages/security/src/index.js";

describe("AI Command credential-content guard", () => {
  it.each([
    "password: this-value-must-not-be-stored",
    "api_key = this-value-must-not-be-stored",
    "Authorization: Bearer this-value-must-not-be-stored",
    "https://operator:this-value-must-not-be-stored@example.invalid/path",
  ])("detects explicit credential-like input without persisting it", (value) => {
    expect(containsCredentialLikeContent(value)).toBe(true);
    expect(() => requireCredentialSafeContent(value)).toThrow(SensitiveContentRejectedError);
  });

  it("allows ordinary operational requests and credential-safety questions", () => {
    expect(containsCredentialLikeContent("Show connector health")).toBe(false);
    expect(containsCredentialLikeContent("How are credentials protected?")).toBe(false);
    expect(() => requireCredentialSafeContent("Show open tasks")).not.toThrow();
  });
});
