import { describe, expect, it } from "vitest";

import { ROLES, can, navFor, primaryNavFor } from "./roles";

describe("schedule recovery permissions", () => {
  it("keeps recovery management and offers with scheduling staff", () => {
    expect(ROLES.filter((role) => can(role, "recovery.view"))).toEqual([
      "SCHEDULER",
      "CLINICAL",
    ]);
    expect(ROLES.filter((role) => can(role, "recovery.manage"))).toEqual([
      "SCHEDULER",
      "CLINICAL",
    ]);
    expect(ROLES.filter((role) => can(role, "recovery.offer"))).toEqual([
      "SCHEDULER",
      "CLINICAL",
    ]);
  });

  it("lets providers report only their own disruption", () => {
    expect(ROLES.filter((role) => can(role, "recovery.report_own"))).toEqual([
      "PROVIDER",
    ]);
    expect(can("PROVIDER", "recovery.manage")).toBe(false);
    expect(can("PROVIDER", "recovery.offer")).toBe(false);
  });
});

describe("communication permissions", () => {
  it("keeps the delivery queue limited to scheduling and scoped clinical staff", () => {
    expect(ROLES.filter((role) => can(role, "communications.view"))).toEqual([
      "SCHEDULER",
      "CLINICAL",
    ]);
    expect(ROLES.filter((role) => can(role, "communications.manage"))).toEqual([
      "SCHEDULER",
    ]);
    expect(ROLES.filter((role) => can(role, "communications.queue"))).toEqual([
      "SCHEDULER",
    ]);
  });
});

describe("clinical reduction permissions", () => {
  it("keeps reduction decisions with clinical supervisors", () => {
    expect(ROLES.filter((role) => can(role, "schedule.approve_reduction"))).toEqual([
      "CLINICAL",
    ]);
    expect(navFor("CLINICAL").some((item) => item.href === "/reductions")).toBe(true);
    expect(navFor("SCHEDULER").some((item) => item.href === "/reductions")).toBe(false);
  });
});

describe("planned time-off permissions", () => {
  it("lets providers request and only schedulers decide", () => {
    expect(ROLES.filter((role) => can(role, "availability.request"))).toEqual([
      "PROVIDER",
    ]);
    expect(ROLES.filter((role) => can(role, "availability.manage"))).toEqual([
      "SCHEDULER",
    ]);
  });

  it("shows the time-off queue only to its participants", () => {
    expect(navFor("PROVIDER").some((item) => item.href === "/time-off")).toBe(true);
    expect(navFor("SCHEDULER").some((item) => item.href === "/time-off")).toBe(true);
    expect(navFor("CLINICAL").some((item) => item.href === "/time-off")).toBe(false);
  });
});

describe("user access administration", () => {
  it("keeps account activation and role changes with administrators", () => {
    expect(ROLES.filter((role) => can(role, "users.manage"))).toEqual(["ADMIN"]);
    expect(navFor("ADMIN").some((item) => item.href === "/configuration")).toBe(true);
    expect(navFor("OPERATIONS").some((item) => item.href === "/configuration")).toBe(false);
  });
});

describe("mobile primary navigation", () => {
  it.each([
    ["SCHEDULER", ["/dashboard", "/schedule", "/recovery", "/communications"]],
    ["CLINICAL", ["/dashboard", "/schedule", "/recovery", "/patients"]],
    ["PROVIDER", ["/dashboard", "/schedule", "/time-off", "/recovery"]],
    ["AUTHORIZATION", ["/dashboard", "/schedule", "/authorizations", "/notifications"]],
    ["OPERATIONS", ["/dashboard", "/schedule", "/capacity", "/reports"]],
    ["ADMIN", ["/dashboard", "/configuration", "/audit", "/settings"]],
    ["COMPLIANCE", ["/dashboard", "/audit", "/notifications", "/settings"]],
  ] as const)("uses role-specific destinations for %s", (role, hrefs) => {
    expect(primaryNavFor(role).map((item) => item.href)).toEqual(hrefs);
  });

  it("labels the provider recovery action as Report", () => {
    expect(
      primaryNavFor("PROVIDER").find((item) => item.href === "/recovery")?.short,
    ).toBe("Report");
  });

  it("only selects destinations the role can access", () => {
    for (const role of ROLES) {
      const allowed = new Set(navFor(role).map((item) => item.href));
      expect(primaryNavFor(role).every((item) => allowed.has(item.href))).toBe(true);
    }
  });
});
