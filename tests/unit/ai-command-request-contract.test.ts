import { describe, expect, it } from "vitest";
import {
  parseAiCommandMessageBody,
  parseAiCommandReservationBody,
} from "../../apps/web/lib/ai-command-request-contract.js";

describe("AI Command request API contract", () => {
  it("requires a server reservation for AI Command message API bodies", () => {
    expect(parseAiCommandReservationBody({ conversationId: "not-a-uuid" })).toBeNull();
    expect(
      parseAiCommandReservationBody({
        conversationId: " 95000000-0000-4000-8000-000000000001 ",
      }),
    ).toEqual({
      conversationId: "95000000-0000-4000-8000-000000000001",
    });
    expect(
      parseAiCommandMessageBody({
        conversationId: "95000000-0000-4000-8000-000000000001",
        message: "Show all companies",
        requestId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toBeNull();
    expect(
      parseAiCommandMessageBody({
        conversationId: "95000000-0000-4000-8000-000000000001",
        message: "Show all companies",
        requestId: "00000000-0000-4000-8000-000000000001",
        generation: 7,
      }),
    ).toEqual({
      conversationId: "95000000-0000-4000-8000-000000000001",
      message: "Show all companies",
      requestId: "00000000-0000-4000-8000-000000000001",
      generation: 7,
    });
  });
});
