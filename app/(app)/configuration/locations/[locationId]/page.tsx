import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { updateLocationConfiguration } from "@/lib/configuration/actions";
import { LOCATION_TYPES } from "@/lib/configuration/validation";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

export default async function LocationConfig({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const session = await requirePermission("config.resources");
  const { locationId } = await params;
  const query = await searchParams;
  const { ctx } = await loadHorizon({ startDate: defaultWeekStart() });
  const location = ctx.locations.get(locationId);
  if (!location) notFound();
  const resources = [...ctx.resources.values()].filter(
    (resource) => resource.location_id === location.id,
  );
  const canSave = can(session.role, "config.services");

  return (
    <div className="space-y-5">
      <div>
        <Link href="/configuration" className="text-xs underline underline-offset-4">
          ← Configuration
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{location.name}</h1>
        <p className="text-sm text-[var(--ink-secondary)]">{location.type} location</p>
      </div>

      {query.error && <Message tone="error">{query.error}</Message>}
      {query.notice && <Message>{query.notice}</Message>}
      {!canSave && (
        <Message tone="warning">
          This is a read-only operational view. A system administrator must commit configuration changes.
        </Message>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader title="Location details" sub="Changes are validated and recorded in the audit log" />
          <form action={updateLocationConfiguration} className="mt-5 space-y-5">
            <input type="hidden" name="location_id" value={location.id} />
            <fieldset disabled={!canSave} className="space-y-5 disabled:opacity-70">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <input required maxLength={120} name="name" className={inputClass} defaultValue={location.name} />
                </Field>
                <Field label="Type">
                  <select name="type" className={inputClass} defaultValue={location.type}>
                    {LOCATION_TYPES.map((type) => <option key={type}>{type}</option>)}
                  </select>
                </Field>
                <Field label="City">
                  <input maxLength={100} name="city" className={inputClass} defaultValue={location.city ?? ""} />
                </Field>
                <Field label="State">
                  <input maxLength={100} name="state" className={inputClass} defaultValue={location.state ?? ""} />
                </Field>
                <Field label="Timezone" hint="IANA name, for example America/New_York">
                  <input required maxLength={100} name="timezone" className={inputClass} defaultValue={location.timezone} />
                </Field>
              </div>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="active" defaultChecked={location.active} /> Active
              </label>
              {canSave && (
                <div className="flex flex-wrap gap-3 border-t border-[var(--rule-hairline)] pt-4">
                  <ActionSubmit pendingLabel="Saving location…">Save location</ActionSubmit>
                  <button type="reset" className="min-h-11 rounded-full border border-[var(--border-ring)] px-4 text-sm">Reset</button>
                </div>
              )}
            </fieldset>
          </form>
        </Card>

        <Card>
          <CardHeader title="Rooms and equipment" />
          <ul className="mt-4 space-y-2 text-sm">
            {resources.map((resource) => (
              <li key={resource.id}>
                <Link className="underline underline-offset-4" href={`/configuration/resources/${resource.id}`}>
                  {resource.name}
                </Link>{" "}· capacity {resource.capacity}
              </li>
            ))}
            {resources.length === 0 && <li className="text-[var(--ink-secondary)]">No resources at this location.</li>}
          </ul>
        </Card>
      </div>
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
