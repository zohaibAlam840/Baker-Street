import { describe, expect, it } from "vitest";
import { claimsDateRange } from "./range";

describe("claims date range", () => {
  it("accepts a bounded exclusive range", () => {
    expect(claimsDateRange("2026-10-01", "2026-11-01")).toEqual({ startDate: "2026-10-01", endDateExclusive: "2026-11-01" });
  });
  it("rejects reversed or oversized ranges", () => {
    expect(() => claimsDateRange("2026-11-01", "2026-10-01")).toThrow(/INVALID/);
    expect(() => claimsDateRange("2026-01-01", "2026-12-31")).toThrow(/INVALID/);
  });
});
