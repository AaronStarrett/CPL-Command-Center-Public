import type { CplActionTarget } from "@bea/domain/cpl-automation";

/** A closed record identity, never a caller-provided navigation URL. */
export type WorkspaceRecordIntent = Omit<CplActionTarget, "kind"> & {
  kind: "proposal" | "project" | "visit" | "report" | "package";
  nonce: number;
};
