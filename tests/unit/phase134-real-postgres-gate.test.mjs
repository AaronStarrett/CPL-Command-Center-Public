import { describe, expect, it } from "vitest";

import {
  DISPOSABLE_POSTGRES_CONFIRMATION_PREFIX,
  inspectRealPostgresPrerequisite,
} from "../../scripts/verify-phase1-3-4-real-postgres.mjs";

describe("Phase 1.3.4 real PostgreSQL external gate", () => {
  it("requires owner prerequisites without attempting to parse or contact a database", () => {
    expect(inspectRealPostgresPrerequisite({})).toEqual({
      ready: false,
      status: "OWNER_PREREQUISITE_REQUIRED",
      detail:
        "Supply an explicit disposable real PostgreSQL URL and its exact database-name confirmation.",
    });
  });

  it("refuses ambiguous or production-looking database targets", () => {
    expect(() =>
      inspectRealPostgresPrerequisite({
        BEA_PHASE134_REAL_POSTGRES_URL: "postgresql://bea:secret@127.0.0.1/bea_production",
        BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION: "RUN PHASE134 AGAINST bea_production",
      }),
    ).toThrow(/name does not contain phase134, test, or disposable/u);
  });

  it("requires an exact database-name acknowledgement before returning the URL to the harness", () => {
    const database = "bea_phase134_disposable";
    const url = `postgresql://bea:secret@127.0.0.1:5544/${database}`;
    expect(() =>
      inspectRealPostgresPrerequisite({
        BEA_PHASE134_REAL_POSTGRES_URL: url,
        BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION: "YES",
      }),
    ).toThrow(/exact database name/u);
    expect(
      inspectRealPostgresPrerequisite({
        BEA_PHASE134_REAL_POSTGRES_URL: url,
        BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION:
          DISPOSABLE_POSTGRES_CONFIRMATION_PREFIX + database,
      }),
    ).toEqual({ ready: true, status: "READY", database, url });
  });
});
