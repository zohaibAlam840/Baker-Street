import { describe, expect, it } from "vitest";

import { activeGeneratedPlans, type OptimizationPlanDecision } from "./decisions";

const now = new Date("2026-10-21T12:00:00Z");

function decision(
  planId: string,
  kind: "REJECTED" | "DEFERRED",
  deferredUntil: string | null,
): OptimizationPlanDecision {
  return {
    id: `decision-${planId}`,
    plan_id: planId,
    decision: kind,
    reason: "Reviewed by scheduling",
    deferred_until: deferredUntil,
    plan_summary: {},
    decided_by: "user-1",
    version: 1,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

describe("optimizer plan decisions", () => {
  const plans = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("keeps rejected plans out of the active queue", () => {
    expect(activeGeneratedPlans(plans, [decision("b", "REJECTED", null)], now)).toEqual([
      { id: "a" },
      { id: "c" },
    ]);
  });

  it("hides a deferred plan only until follow-up is due", () => {
    expect(activeGeneratedPlans(
      plans,
      [decision("b", "DEFERRED", "2026-10-22T12:00:00Z")],
      now,
    )).toHaveLength(2);
    expect(activeGeneratedPlans(
      plans,
      [decision("b", "DEFERRED", "2026-10-21T11:59:59Z")],
      now,
    )).toEqual(plans);
  });
});
