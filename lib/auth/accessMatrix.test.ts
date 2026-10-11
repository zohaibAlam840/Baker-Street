import { describe, expect, it } from "vitest";
import { ROLES } from "./roles";
import { mayManageAppointments, mayManageAuthorizations, mayManageClinicalRequirements, mayManageConfiguration, mayReadAudit, mayReadPatient, mayReadProvider } from "./accessMatrix";

describe("seven-role access matrix", () => {
  it("gives every role only its intended patient scope", () => {
    expect(ROLES.filter(r => mayReadPatient(r, "unrelated"))).toEqual(["SCHEDULER", "AUTHORIZATION", "OPERATIONS"]);
    expect(ROLES.filter(r => mayReadPatient(r, "team"))).toEqual(["SCHEDULER", "CLINICAL", "PROVIDER", "AUTHORIZATION", "OPERATIONS"]);
    expect(mayReadPatient("ADMIN", "team")).toBe(false);
    expect(mayReadPatient("COMPLIANCE", "team")).toBe(false);
  });

  it("limits a provider to their own staff record", () => {
    expect(mayReadProvider("PROVIDER", "self")).toBe(true);
    expect(mayReadProvider("PROVIDER", "unrelated")).toBe(false);
    expect(mayReadProvider("AUTHORIZATION", "self")).toBe(false);
  });

  it("separates operational write authority", () => {
    expect(ROLES.filter(mayManageAppointments)).toEqual(["SCHEDULER", "CLINICAL"]);
    expect(ROLES.filter(mayManageClinicalRequirements)).toEqual(["CLINICAL"]);
    expect(ROLES.filter(mayManageAuthorizations)).toEqual(["AUTHORIZATION"]);
    expect(ROLES.filter(mayManageConfiguration)).toEqual(["ADMIN"]);
  });

  it("keeps audit access oversight-only", () => {
    expect(ROLES.filter(mayReadAudit)).toEqual(["CLINICAL", "OPERATIONS", "ADMIN", "COMPLIANCE"]);
  });
});
