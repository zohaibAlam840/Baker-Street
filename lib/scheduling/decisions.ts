export type OptimizationPlanDecision = {
  id: string;
  plan_id: string;
  decision: "REJECTED" | "DEFERRED";
  reason: string;
  deferred_until: string | null;
  plan_summary: Record<string, unknown>;
  decided_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export function decisionSuppressesPlan(
  decision: OptimizationPlanDecision | undefined,
  now: Date,
): boolean {
  if (!decision) return false;
  if (decision.decision === "REJECTED") return true;
  return Boolean(
    decision.deferred_until
    && new Date(decision.deferred_until).getTime() > now.getTime(),
  );
}

export function activeGeneratedPlans<T extends { id: string }>(
  plans: readonly T[],
  decisions: readonly OptimizationPlanDecision[],
  now: Date,
): T[] {
  const byPlan = new Map(decisions.map((decision) => [decision.plan_id, decision]));
  return plans.filter((plan) => !decisionSuppressesPlan(byPlan.get(plan.id), now));
}
