export interface ProgrammaticScrollSession {
  readonly generation: number;
  readonly cancel: () => void;
}

export function attachProgrammaticScroll(input: {
  readonly target: EventTarget | null;
  readonly generation: number;
  readonly settleMs: number;
  readonly schedule: (callback: () => void, ms: number) => number;
  readonly clearSchedule: (handle: number) => void;
  readonly onSettle: (generation: number) => void;
}): ProgrammaticScrollSession {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    input.target?.removeEventListener("scrollend", finish);
    input.clearSchedule(timer);
    input.onSettle(input.generation);
  };
  input.target?.addEventListener("scrollend", finish, { once: true });
  const timer = input.schedule(finish, input.settleMs);
  return {
    generation: input.generation,
    cancel() {
      if (settled) return;
      settled = true;
      input.target?.removeEventListener("scrollend", finish);
      input.clearSchedule(timer);
    },
  };
}

export function isProgrammaticScrollActive(input: {
  readonly token: number | null;
  readonly flag: boolean;
}): boolean {
  return input.flag || input.token !== null;
}
