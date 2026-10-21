"use client";

import { useState } from "react";

import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { recordOptimizationPlanDecision } from "@/lib/scheduling/actions";

export function PlanDecisionForm({
  patientId,
  week,
  planId,
  weekEnd,
}: {
  patientId: string;
  week: string;
  planId: string;
  weekEnd: string;
}) {
  const [decision, setDecision] = useState<"REJECTED" | "DEFERRED">("REJECTED");

  return (
    <form action={recordOptimizationPlanDecision} className="mt-3 space-y-3 rounded-xl border border-[var(--border-ring)] p-3">
      <input type="hidden" name="patient_id" value={patientId} />
      <input type="hidden" name="week" value={week} />
      <input type="hidden" name="plan_id" value={planId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-[var(--ink-secondary)]">
          Decision
          <select
            name="decision"
            value={decision}
            onChange={(event) => setDecision(event.target.value as "REJECTED" | "DEFERRED")}
            className="mt-1.5 min-h-11 w-full rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 text-sm"
          >
            <option value="REJECTED">Reject this option</option>
            <option value="DEFERRED">Defer for follow-up</option>
          </select>
        </label>
        {decision === "DEFERRED" && (
          <label className="text-xs font-medium text-[var(--ink-secondary)]">
            Follow up by
            <input
              required
              type="datetime-local"
              name="deferred_until"
              max={`${weekEnd}T23:45`}
              className="mt-1.5 min-h-11 w-full rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 text-sm"
            />
          </label>
        )}
      </div>
      <label className="block text-xs font-medium text-[var(--ink-secondary)]">
        Reason
        <textarea
          required
          minLength={3}
          maxLength={500}
          name="reason"
          placeholder={decision === "REJECTED" ? "Why should this option not be used?" : "What needs review before this option returns?"}
          className="mt-1.5 min-h-20 w-full rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3 text-sm"
        />
      </label>
      <ActionSubmit
        tone="secondary"
        className="w-full"
        pendingLabel={decision === "REJECTED" ? "Rejecting option…" : "Deferring option…"}
      >
        {decision === "REJECTED" ? "Reject option" : "Defer option"}
      </ActionSubmit>
    </form>
  );
}
