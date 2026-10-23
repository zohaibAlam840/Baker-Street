import { afterEach, describe, expect, it, vi } from "vitest";

import { logEvent, sanitizeLogDetails } from "./logger";

afterEach(() => vi.restoreAllMocks());

describe("PHI-safe structured logging", () => {
  it("keeps reviewed operational fields and redacts everything else", () => {
    expect(sanitizeLogDetails({
      status: "degraded",
      failed_count: 3,
      patient_id: "patient-123",
      email: "person@example.org",
      arbitrary: { name: "Private Person" },
    })).toEqual({
      status: "degraded",
      failed_count: 3,
      patient_id: "[REDACTED]",
      email: "[REDACTED]",
      arbitrary: "[REDACTED]",
    });
  });

  it("prevents details from replacing the structured envelope", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logEvent("info", "health.checked", {
      event: "forged.event",
      release: "forged-release",
      processed: 4,
    });

    const payload = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(payload.event).toBe("health.checked");
    expect(payload.release).not.toBe("forged-release");
    expect(payload.processed).toBe(4);
  });

  it("removes control characters and bounds logged strings", () => {
    const result = sanitizeLogDetails({ error_code: `BAD\nCODE${"x".repeat(300)}` });
    expect(result.error_code).not.toContain("\n");
    expect(String(result.error_code)).toHaveLength(200);
  });
});
