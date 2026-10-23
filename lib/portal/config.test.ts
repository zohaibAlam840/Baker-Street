import { describe, expect, it } from "vitest";

import { guardianPortalEnabled } from "./config";

describe("guardian portal configuration", () => {
  it("is disabled by default", () => expect(guardianPortalEnabled({})).toBe(false));
  it("accepts an explicit gate", () => expect(guardianPortalEnabled({ GUARDIAN_PORTAL_ENABLED: "true" })).toBe(true));
  it("rejects ambiguous values", () => expect(() => guardianPortalEnabled({ GUARDIAN_PORTAL_ENABLED: "yes" })).toThrow(/true or false/));
});
