import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { createAuthorization } from "@/lib/workflows/actions";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; patient?: string }>;
}) {
  await requirePermission("authorization.manage");
  const [query, { ctx }] = await Promise.all([
    searchParams,
    loadHorizon({ startDate: defaultWeekStart() }),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/authorizations" className="text-xs underline">
          ← Authorizations
        </Link>
        <h1 className="mt-2 text-xl font-semibold">New authorization</h1>
      </div>
      {query.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {query.error}
        </p>
      )}
      <Card>
        <CardHeader title="Payer approval" />
        <form action={createAuthorization} className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
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
            <Field label="Payer">
              <input name="payer" className={inputClass} />
            </Field>
            <Field label="Authorization number">
              <input name="authorization_number" className={inputClass} />
            </Field>
            <Field label="Authorized hours">
              <input name="authorized_hours" type="number" min="0" step="0.25" className={inputClass} />
            </Field>
            <Field label="Units per hour">
              <input name="units_per_hour" type="number" min="0" defaultValue="4" className={inputClass} />
            </Field>
            <Field label="Start date">
              <input required name="start_date" type="date" className={inputClass} />
            </Field>
            <Field label="End date">
              <input required name="end_date" type="date" className={inputClass} />
            </Field>
            <Field label="Status">
              <select name="status" className={inputClass}>
                <option>ACTIVE</option>
                <option>PENDING</option>
                <option>DENIED</option>
              </select>
            </Field>
          </div>
          <ActionSubmit pendingLabel="Creating authorization…">Create authorization</ActionSubmit>
        </form>
      </Card>
    </div>
  );
}
