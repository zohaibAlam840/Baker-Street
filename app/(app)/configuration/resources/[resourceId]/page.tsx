import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { updateResourceConfiguration } from "@/lib/configuration/actions";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

export default async function ResourceConfig({
  params,
  searchParams,
}: {
  params: Promise<{ resourceId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const session = await requirePermission("config.resources");
  const { resourceId } = await params;
  const query = await searchParams;
  const { ctx } = await loadHorizon({ startDate: defaultWeekStart() });
  const resource = ctx.resources.get(resourceId);
  if (!resource) notFound();
  const canSave = can(session.role, "config.services");

  return (
    <div className="space-y-5">
      <div>
        <Link href="/configuration" className="text-xs underline underline-offset-4">← Configuration</Link>
        <h1 className="mt-2 text-xl font-semibold">{resource.name}</h1>
        <p className="text-sm text-[var(--ink-secondary)]">Room or equipment capacity</p>
      </div>

      {query.error && <Message tone="error">{query.error}</Message>}
      {query.notice && <Message>{query.notice}</Message>}
      {!canSave && (
        <Message tone="warning">
          This is a read-only operational view. A system administrator must commit configuration changes.
        </Message>
      )}

      <Card>
        <CardHeader title="Resource details" sub="Future bookings are protected before a capacity or location change is accepted" />
        <form action={updateResourceConfiguration} className="mt-5 space-y-5">
          <input type="hidden" name="resource_id" value={resource.id} />
          <fieldset disabled={!canSave} className="space-y-5 disabled:opacity-70">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <input required maxLength={120} name="name" className={inputClass} defaultValue={resource.name} />
              </Field>
              <Field label="Type">
                <input required maxLength={80} name="resource_type" className={inputClass} defaultValue={resource.resource_type} />
              </Field>
              <Field label="Capacity">
                <input required type="number" min={1} max={10000} step={1} name="capacity" className={inputClass} defaultValue={resource.capacity} />
              </Field>
              <Field label="Location">
                <select name="location_id" className={inputClass} defaultValue={resource.location_id ?? ""}>
                  <option value="">No location</option>
                  {[...ctx.locations.values()].map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={resource.active} /> Active and bookable
            </label>
            {canSave && (
              <div className="flex flex-wrap gap-3 border-t border-[var(--rule-hairline)] pt-4">
                <ActionSubmit pendingLabel="Saving resource…">Save resource</ActionSubmit>
                <button type="reset" className="min-h-11 rounded-full border border-[var(--border-ring)] px-4 text-sm">Reset</button>
              </div>
            )}
          </fieldset>
        </form>
      </Card>
    </div>
  );
}

function Message({ children, tone = "success" }: { children: React.ReactNode; tone?: "success" | "warning" | "error" }) {
  const styles = tone === "error"
    ? "bg-red-50 text-red-800"
    : tone === "warning"
      ? "bg-amber-50 text-amber-900"
      : "bg-[var(--brand-tint)] text-[var(--ink-primary)]";
  return <p role={tone === "error" ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${styles}`}>{children}</p>;
}
