"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { approveOptimizationPlan } from "@/lib/scheduling/actions";

export function ApprovalForm({
  patientId,
  week,
  planId,
  appointmentCount,
  moveCount,
  addedHours,
  optionLabel,
  patientName,
  weekLabel,
}: {
  patientId: string;
  week: string;
  planId: string;
  appointmentCount: number;
  moveCount: number;
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
        <ApprovalConfirmation
          appointmentCount={appointmentCount}
          moveCount={moveCount}
          addedHours={addedHours}
          optionLabel={optionLabel}
          patientName={patientName}
          weekLabel={weekLabel}
          onCancel={() => setConfirming(false)}
        />
      )}
      <p className="text-[0.625rem] leading-relaxed text-[var(--ink-muted)]">
        Live constraints are checked again. If anything changed, the entire plan rolls back.
      </p>
    </form>
  );
}

function ApprovalConfirmation({
  appointmentCount,
  moveCount,
  addedHours,
  optionLabel,
  patientName,
  weekLabel,
  onCancel,
}: {
  appointmentCount: number;
  moveCount: number;
  addedHours: number;
  optionLabel: string;
  patientName: string;
  weekLabel: string;
  onCancel: () => void;
}) {
  const { pending } = useFormStatus();

  return (
    <fieldset
      disabled={pending}
      aria-busy={pending}
      className="min-w-0 space-y-3 border-0 p-0 disabled:cursor-wait"
    >
      <div className="rounded-xl bg-[var(--surface-sunken)] p-3 text-xs leading-relaxed text-[var(--ink-secondary)]">
        <strong className="block text-[var(--ink-primary)]">Confirm {optionLabel}</strong>
        {patientName} · {weekLabel} · {appointmentCount} new visit
        {appointmentCount === 1 ? "" : "s"}
        {moveCount > 0 && ` · ${moveCount} flexible visit moved`} · +{addedHours}h
      </div>
      <label className="block">
        <span className="text-xs font-medium text-[var(--ink-secondary)]">Approval reason</span>
        <textarea
          required
          minLength={3}
          name="reason"
          autoFocus
          placeholder="Document why this plan is being approved"
          className="mt-1.5 min-h-20 w-full rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] p-3 text-sm text-[var(--ink-primary)] outline-none disabled:cursor-wait disabled:opacity-70 focus:ring-2 focus:ring-[var(--brand-ring)]"
        />
      </label>
      <ActionSubmit className="w-full" pendingLabel="Rechecking live schedule…">
        Approve plan
      </ActionSubmit>
      {pending && (
        <p aria-hidden="true" className="text-center text-xs text-[var(--ink-secondary)]">
          Checking live constraints. Keep this screen open.
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        aria-disabled={pending}
        onClick={onCancel}
        className="min-h-11 w-full rounded-full border border-[var(--border-ring)] px-5 text-sm font-medium text-[var(--ink-primary)] disabled:cursor-wait disabled:opacity-60"
      >
        Go back
      </button>
    </fieldset>
  );
}
