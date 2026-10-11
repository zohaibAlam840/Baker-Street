import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader, SegmentBar } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { updateAuthorization } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ authorizationId: string }>;
  searchParams: Promise<{ week?: string; error?: string; notice?: string }>;
}) {
  await requirePermission("authorization.manage");
  const [{ authorizationId }, query] = await Promise.all([params, searchParams]);
  const { ctx } = await loadHorizon({ startDate: query.week ?? defaultWeekStart() });
  const authorization = ctx.rows.authorizations.find((item) => item.id === authorizationId);
  if (!authorization) notFound();

  const patient = ctx.patients.get(authorization.patient_id);
  const service = ctx.services.get(authorization.service_id);
  const used = slotsToHours(ctx.slotsUsedAgainstAuthorization(authorization.id));
  const total = authorization.authorized_hours ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/authorizations" className="text-xs underline">
          ← Authorizations
        </Link>
        <h1 className="mt-2 text-xl font-semibold">
          {patient?.first_name} {patient?.last_name} · {service?.service_name}
        </h1>
        <p className="text-sm text-[var(--ink-secondary)]">
          {authorization.payer ?? "No payer"} · {authorization.authorization_number ?? "No reference"}
        </p>
      </div>

      {query.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {query.error}
        </p>
      )}
      {query.notice && (
        <p role="status" className="rounded-lg bg-[var(--brand-tint)] p-3 text-sm">
          {query.notice}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader title="Authorization details" />
          <form action={updateAuthorization} className="mt-5 space-y-5">
            <input type="hidden" name="authorization_id" value={authorization.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Payer">
                <input name="payer" className={inputClass} defaultValue={authorization.payer ?? ""} />
              </Field>
              <Field label="Authorization number">
                <input
                  name="authorization_number"
                  className={inputClass}
                  defaultValue={authorization.authorization_number ?? ""}
                />
              </Field>
              <Field label="Authorized hours">
                <input
                  name="authorized_hours"
                  type="number"
                  min="0"
                  step="0.25"
                  className={inputClass}
                  defaultValue={authorization.authorized_hours ?? ""}
                />
              </Field>
              <Field label="Units per hour">
                <input
                  name="units_per_hour"
                  type="number"
                  min="0"
                  className={inputClass}
                  defaultValue={authorization.units_per_hour}
                />
              </Field>
              <Field label="Start date">
                <input
                  required
                  name="start_date"
                  type="date"
                  className={inputClass}
                  defaultValue={authorization.start_date}
                />
              </Field>
              <Field label="End date">
                <input
                  required
                  name="end_date"
                  type="date"
                  className={inputClass}
                  defaultValue={authorization.end_date}
                />
              </Field>
              <Field label="Status">
                <select name="status" className={inputClass} defaultValue={authorization.status}>
                  {["ACTIVE", "PENDING", "EXHAUSTED", "EXPIRED", "DENIED"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
            </div>
            <ActionSubmit pendingLabel="Saving authorization…">Save authorization</ActionSubmit>
          </form>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Utilization this week" />
            <div className="mt-4">
              <SegmentBar
                value={used}
                total={Math.max(total, 1)}
                leftLabel="Used"
                rightLabel="Authorized"
                leftValue={`${used}h`}
                rightValue={`${total}h`}
              />
            </div>
          </Card>
          <Card>
            <Link href={`/patients/${authorization.patient_id}`} className="text-sm underline">
              Open patient record
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
