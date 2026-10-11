import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { updateClinicalRequirement } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ requirementId: string }>;
  searchParams: Promise<{ week?: string; error?: string; notice?: string }>;
}) {
  await requirePermission("clinical.set_requirements");
  const [{ requirementId }, query] = await Promise.all([params, searchParams]);
  const { ctx } = await loadHorizon({ startDate: query.week ?? defaultWeekStart() });
  const requirement = ctx.rows.patientServiceRequirements.find(
    (item) => item.id === requirementId,
  );
  if (!requirement) notFound();

  const patient = ctx.patients.get(requirement.patient_id);
  const service = ctx.services.get(requirement.service_id);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/clinical" className="text-xs underline">
          ← Clinical requirements
        </Link>
        <h1 className="mt-2 text-xl font-semibold">
          {patient?.first_name} {patient?.last_name} · {service?.service_name}
        </h1>
        <p className="text-sm text-[var(--ink-secondary)]">
          Clinical need remains independent from payer authorization.
        </p>
      </div>

      {query.error && <Notice error>{query.error}</Notice>}
      {query.notice && <Notice>{query.notice}</Notice>}

      <Card>
        <CardHeader title="Weekly requirement" sub="Floor, target, ceiling, and frequency" />
        <form action={updateClinicalRequirement} className="mt-5 space-y-5">
          <input type="hidden" name="requirement_id" value={requirement.id} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField name="minimum_hours" label="Minimum hours" value={requirement.minimum_hours_per_week} />
            <NumberField name="target_hours" label="Target hours" value={requirement.target_hours_per_week} />
            <NumberField name="maximum_hours" label="Maximum hours" value={requirement.maximum_hours_per_week} />
            <NumberField name="minimum_sessions" label="Minimum sessions" value={requirement.minimum_sessions_per_week} step="1" />
            <NumberField name="target_sessions" label="Target sessions" value={requirement.target_sessions_per_week} step="1" />
            <NumberField name="maximum_sessions" label="Maximum sessions" value={requirement.maximum_sessions_per_week} step="1" />
            <NumberField name="priority" label="Priority" value={requirement.priority} step="1" />
            <Field label="Effective start">
              <input
                required
                name="effective_start"
                type="date"
                className={inputClass}
                defaultValue={requirement.effective_start}
              />
            </Field>
            <Field label="Effective end">
              <input
                name="effective_end"
                type="date"
                className={inputClass}
                defaultValue={requirement.effective_end ?? ""}
              />
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input name="required" type="checkbox" defaultChecked={requirement.required} /> Required service
          </label>
          <Field label="Clinical reason for change">
            <textarea required name="reason" className={`${inputClass} min-h-28`} />
          </Field>
          <ActionSubmit pendingLabel="Saving requirement…">Save requirement</ActionSubmit>
        </form>
      </Card>
    </div>
  );
}

function NumberField({
  name,
  label,
  value,
  step = "0.25",
}: {
  name: string;
  label: string;
  value: number | null;
  step?: string;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        type="number"
        min="0"
        step={step}
        className={inputClass}
        defaultValue={value ?? ""}
      />
    </Field>
  );
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={`rounded-lg p-3 text-sm ${error ? "bg-red-50 text-red-700" : "bg-[var(--brand-tint)]"}`}
    >
      {children}
    </p>
  );
}
