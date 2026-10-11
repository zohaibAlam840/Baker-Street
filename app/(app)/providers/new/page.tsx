import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { createProvider } from "@/lib/workflows/actions";

const types = [
  "RBT",
  "BCBA",
  "PSYCHOLOGIST",
  "NEUROPSYCHOLOGIST",
  "LMHC",
  "LCSW",
  "LPC",
  "OT",
  "PT",
  "SLP",
  "PODIATRIST",
  "MD",
  "DO",
  "TECHNICIAN",
  "OTHER",
];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("credentials.manage");
  const [{ ctx }, query] = await Promise.all([
    loadHorizon({ startDate: defaultWeekStart() }),
    searchParams,
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/providers" className="text-xs underline">
          ← Clinicians
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Add clinician</h1>
        <p className="text-sm text-[var(--ink-secondary)]">
          Create a staff record and its initial credential.
        </p>
      </div>
      {query.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {query.error}
        </p>
      )}
      <Card>
        <CardHeader title="Clinician details" />
        <form action={createProvider} className="mt-5 space-y-5">
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
            <Field label="Provider type">
              <select name="provider_type" className={inputClass}>
                {types.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select name="status" className={inputClass}>
                <option>ACTIVE</option>
                <option>ON_LEAVE</option>
                <option>INACTIVE</option>
              </select>
            </Field>
            <Field label="Home location">
              <select name="home_location_id" className={inputClass}>
                <option value="">Select location</option>
                {[...ctx.locations.values()].map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Credential type">
              <input name="credential_type" className={inputClass} />
            </Field>
            <Field label="Credential expiration">
              <input name="credential_expiration" type="date" className={inputClass} />
            </Field>
            <Field label="Timezone">
              <input name="timezone" className={inputClass} defaultValue={ctx.grid.timeZone} />
            </Field>
          </div>
          <ActionSubmit className="w-full sm:w-auto" pendingLabel="Creating clinician…">
            Create clinician
          </ActionSubmit>
        </form>
      </Card>
    </div>
  );
}
