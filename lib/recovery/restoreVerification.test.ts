import { describe, expect, it } from "vitest";

import { REQUIRED_SCHEMA_VERSION } from "../deployment/verification";

import {
  RECOVERY_MANIFEST_VERSION,
  RECOVERY_TABLES,
  type RecoveryManifest,
  normalizeRecoveryUrl,
  recoveryManifestErrors,
} from "./restoreVerification";

function manifest(host: string): RecoveryManifest {
  return {
    format_version: RECOVERY_MANIFEST_VERSION,
    schema_version: REQUIRED_SCHEMA_VERSION,
    source_host: host,
    captured_at: "2026-10-23T00:00:00.000Z",
    tables: Object.fromEntries(RECOVERY_TABLES.map(({ name }) => [
      name,
      { rows: 2, hmac: "a".repeat(64) },
    ])),
    auth_users: { rows: 1, hmac: "b".repeat(64) },
  };
}

describe("restore verification", () => {
  it("normalizes a secure project URL", () => {
    expect(normalizeRecoveryUrl("https://project.supabase.co/rest/v1?x=1").href)
      .toBe("https://project.supabase.co/");
    expect(() => normalizeRecoveryUrl("http://project.supabase.co"))
      .toThrow("HTTPS");
  });

  it("accepts an exact restore in a different project", () => {
    const source = manifest("source.supabase.co");
    const restored = { ...manifest("restore.supabase.co"), captured_at: "later" };
    expect(recoveryManifestErrors(source, restored)).toEqual([]);
  });

  it("reports mismatches without exposing counts or row data", () => {
    const source = manifest("source.supabase.co");
    const restored = manifest("source.supabase.co");
    restored.tables.patients = { rows: 3, hmac: "c".repeat(64) };
    restored.auth_users = { rows: 2, hmac: "d".repeat(64) };
    const errors = recoveryManifestErrors(source, restored);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("isolated project"),
      "Restore integrity mismatch: patients.",
      "Restore integrity mismatch: authentication users.",
    ]));
    expect(errors.join(" ")).not.toContain("cccccccc");
  });
});
