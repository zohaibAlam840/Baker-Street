import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { createClinicalRequirement } from "@/lib/workflows/actions";

const requirementFields = [
  ["minimum_hours", "Minimum hours"],
  ["target_hours", "Target hours"],
  ["maximum_hours", "Maximum hours"],
  ["minimum_sessions", "Minimum sessions"],
  ["target_sessions", "Target sessions"],
  ["maximum_sessions", "Maximum sessions"],
] as const;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; patient?: string }>;
}) {
  await requirePermission("clinical.set_requirements");
  const [query, { ctx }] = await Promise.all([
    searchParams,
    loadHorizon({ startDate: defaultWeekStart() }),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/clinical" className="text-xs underline">
          ← Clinical
        </Link>
        <h1 className="mt-2 text-xl font-semibold">New clinical requirement</h1>
      </div>
      {query.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {query.error}
        </p>
      )}
      <Card>
        <CardHeader title="Required care" />
        <form action={createClinicalRequirement} className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Patient">
              <select required name="patient_id" className={inputClass} defaultValue={query.patient ?? ""}>
                <option value="">Select patient</option>
                {[...ctx.patients.values()].map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.first_name} {patient.last_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Service">
              <select required name="service_id" className={inputClass}>
                <option value="">Select service</option>
                {[...ctx.services.values()].map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.service_name}
                  </option>
                ))}
              </select>
            </Field>
            {requirementFields.map(([name, label]) => (
              <Field key={name} label={label}>
                <input name={name} type="number" min="0" step="0.25" className={inputClass} />
              </Field>
            ))}
            <Field label="Effective start">
              <input name="effective_start" type="date" className={inputClass} />
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input name="required" type="checkbox" /> Required service
          </label>
          <ActionSubmit pendingLabel="Creating requirement…">Create requirement</ActionSubmit>
        </form>
      </Card>
    </div>
  );
}
