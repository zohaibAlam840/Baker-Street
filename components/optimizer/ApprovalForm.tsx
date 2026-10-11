"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { approveOptimizationPlan } from "@/lib/scheduling/actions";

export function ApprovalForm({
  patientId,
  week,
  planId,
  appointmentCount,
  addedHours,
  optionLabel,
  patientName,
  weekLabel,
}: {
  patientId: string;
  week: string;
  planId: string;
  appointmentCount: number;
  addedHours: number;
  optionLabel: string;
  patientName: string;
  weekLabel: string;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={approveOptimizationPlan} className="mt-4 space-y-3 border-t border-[var(--rule-hairline)] pt-4">
      <input type="hidden" name="patient_id" value={patientId} />
      <input type="hidden" name="week" value={week} />
      <input type="hidden" name="plan_id" value={planId} />
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="min-h-11 w-full rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white"
          aria-label={`Review ${optionLabel} for ${patientName}, ${weekLabel}`}
        >
          Review approval
        </button>
      ) : (
        <div className="space-y-3" aria-live="polite">
          <div className="rounded-xl bg-[var(--surface-sunken)] p-3 text-xs leading-relaxed text-[var(--ink-secondary)]">
            <strong className="block text-[var(--ink-primary)]">Confirm {optionLabel}</strong>
            {patientName} · {weekLabel} · {appointmentCount} new visit{appointmentCount === 1 ? "" : "s"} · +{addedHours}h
          </div>
          <label className="block">
            <span className="text-xs font-medium text-[var(--ink-secondary)]">Approval reason</span>
            <textarea
              required
              minLength={3}
              name="reason"
              autoFocus
              placeholder="Document why this plan is being approved"
              className="mt-1.5 min-h-20 w-full rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] p-3 text-sm text-[var(--ink-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-ring)]"
            />
          </label>
          <Submit
            count={appointmentCount}
            label={`${optionLabel} for ${patientName}, ${weekLabel}`}
          />
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="min-h-11 w-full rounded-full border border-[var(--border-ring)] px-5 text-sm font-medium text-[var(--ink-primary)]"
          >
            Go back
          </button>
        </div>
      )}
      <p className="text-[0.625rem] leading-relaxed text-[var(--ink-muted)]">
        Live constraints are checked again. If anything changed, the entire plan rolls back.
      </p>
    </form>
  );
}

function Submit({ count, label }: { count: number; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={pending ? "Rechecking the live schedule" : `Confirm approval of ${label}`}
      className="min-h-11 w-full rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "Rechecking live schedule…" : `Approve ${count} appointment${count === 1 ? "" : "s"}`}
    </button>
  );
}
