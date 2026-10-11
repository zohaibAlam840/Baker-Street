import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { createPatient } from "@/lib/workflows/actions";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("schedule.book");
  const [{ ctx }, query] = await Promise.all([
    loadHorizon({ startDate: defaultWeekStart() }),
    searchParams,
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/patients" className="text-xs underline">
          ← Patients
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Add patient</h1>
        <p className="text-sm text-[var(--ink-secondary)]">
          Creates the record and a six-step intake checklist.
        </p>
      </div>
      {query.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {query.error}
        </p>
      )}
      <Card>
        <CardHeader title="Patient details" />
        <form action={createPatient} className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name">
              <input required name="first_name" className={inputClass} />
            </Field>
            <Field label="Last name">
              <input required name="last_name" className={inputClass} />
            </Field>
            <Field label="External ID">
              <input name="external_id" className={inputClass} />
            </Field>
            <Field label="Date of birth">
              <input name="date_of_birth" type="date" className={inputClass} />
            </Field>
            <Field label="Status">
              <select name="status" className={inputClass}>
                <option>PENDING</option>
                <option>ACTIVE</option>
                <option>INACTIVE</option>
                <option>DISCHARGED</option>
              </select>
            </Field>
            <Field label="Primary location">
              <select name="primary_location_id" className={inputClass}>
                <option value="">Select location</option>
                {[...ctx.locations.values()].map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Timezone">
              <input name="timezone" className={inputClass} defaultValue={ctx.grid.timeZone} />
            </Field>
          </div>
          <ActionSubmit className="w-full sm:w-auto" pendingLabel="Creating patient…">
            Create patient
          </ActionSubmit>
        </form>
      </Card>
    </div>
  );
}
