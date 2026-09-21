export interface AiCommandReservationBody {
  readonly conversationId: string;
}

export interface AiCommandMessageBody extends AiCommandReservationBody {
  readonly message: string;
  readonly requestId: string;
  readonly generation: number;
  readonly workspaceSelection?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseAiCommandReservationBody(body: unknown): AiCommandReservationBody | null {
  if (
    !body ||
    typeof body !== "object" ||
    !("conversationId" in body) ||
    typeof body.conversationId !== "string"
  ) {
    return null;
  }
  const conversationId = body.conversationId.trim();
  return UUID_PATTERN.test(conversationId) ? { conversationId } : null;
}

export function parseAiCommandMessageBody(body: unknown): AiCommandMessageBody | null {
  const reservation = parseAiCommandReservationBody(body);
  if (
    !reservation ||
    !body ||
    typeof body !== "object" ||
    !("message" in body) ||
    typeof body.message !== "string" ||
    body.message.trim().length === 0 ||
    body.message.length > 2_000 ||
    !("requestId" in body) ||
    typeof body.requestId !== "string" ||
    !("generation" in body) ||
    typeof body.generation !== "number"
  ) {
    return null;
  }
  return {
    ...reservation,
    message: body.message,
    requestId: body.requestId,
    generation: body.generation,
    ...("workspaceSelection" in body && body.workspaceSelection !== undefined
      ? { workspaceSelection: body.workspaceSelection }
      : {}),
  };
}
