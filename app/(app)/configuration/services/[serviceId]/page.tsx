import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { updateServiceConfiguration } from "@/lib/configuration/actions";
import { CONFIGURATION_OBJECTIVES } from "@/lib/configuration/validation";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

export default async function ServiceConfig({
  params,
  searchParams,
}: {
  params: Promise<{ serviceId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePermission("config.services");
  const { serviceId } = await params;
  const query = await searchParams;
  const { ctx } = await loadHorizon({ startDate: defaultWeekStart() });
  const service = ctx.services.get(serviceId);
  if (!service) notFound();
  const durations = ctx.serviceDurations.get(service.id) ?? [];
  const requiredResourceIds = new Set(
    ctx.rows.serviceResources
      .filter((link) => link.service_id === service.id && link.required)
      .map((link) => link.resource_id),
  );
  const resources = [...ctx.resources.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-5">
      <div>
        <Link href="/configuration" className="text-xs text-[var(--ink-secondary)] underline underline-offset-4">
          ← Configuration
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{service.service_name}</h1>
        <p className="text-sm text-[var(--ink-secondary)]">{service.service_code} · {service.department}</p>
      </div>

      {query.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{query.error}</p>
      )}
      {query.notice && (
        <p role="status" className="rounded-lg bg-[var(--brand-tint)] p-3 text-sm">{query.notice}</p>
      )}
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Service changes affect future scheduling. The save is atomic, protects already-booked visits, and records every changed row in the audit log.
      </p>

      <Card>
        <CardHeader title="Service configuration" sub="Behavior is data, not special-cased code" />
        <form action={updateServiceConfiguration} className="mt-5 space-y-5">
          <input type="hidden" name="service_id" value={service.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input required maxLength={120} name="name" className={inputClass} defaultValue={service.service_name} />
            </Field>
            <Field label="Code" hint="2–32 uppercase letters, numbers, underscores, or hyphens">
              <input required minLength={2} maxLength={32} name="code" className={inputClass} defaultValue={service.service_code} />
            </Field>
            <Field label="Department">
              <input required maxLength={120} name="department" className={inputClass} defaultValue={service.department} />
            </Field>
            <Field label="Allowed durations" hint="Comma-separated 15-minute increments">
              <input required name="durations" className={inputClass} defaultValue={durations.join(", ")} />
            </Field>
            <Field label="Default duration">
              <input required type="number" min={15} max={1440} step={15} name="default_duration" className={inputClass} defaultValue={service.default_duration_minutes} />
            </Field>
            <Field label="Primary objective">
              <select
                name="primary_objective"
                className={inputClass}
                defaultValue={service.optimization_profile.primary_objective ?? "MAXIMIZE_SERVICE_HOURS"}
              >
                {CONFIGURATION_OBJECTIVES.map((objective) => <option key={objective}>{objective}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Checkbox name="requires_authorization" checked={service.requires_authorization}>Requires authorization</Checkbox>
            <Checkbox name="in_person_allowed" checked={service.in_person_allowed}>In-person allowed</Checkbox>
            <Checkbox name="telehealth_allowed" checked={service.telehealth_allowed}>Telehealth allowed</Checkbox>
            <Checkbox name="group_allowed" checked={service.group_allowed}>Group allowed</Checkbox>
            <Checkbox name="active" checked={service.active}>Active</Checkbox>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-[var(--ink-primary)]">Allowed rooms and resources</legend>
            <p className="text-xs text-[var(--ink-muted)]">
              Any one selected resource can satisfy an in-person booking. Leave all clear when no room or equipment is required.
            </p>
            <div className="grid gap-2 rounded-lg border border-[var(--border-ring)] p-3 sm:grid-cols-2">
              {resources.map((resource) => (
                <label key={resource.id} className="flex min-h-10 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="resource_ids"
                    value={resource.id}
                    defaultChecked={requiredResourceIds.has(resource.id)}
                    disabled={!resource.active}
                  />
                  <span>
                    {resource.name}
                    <span className="block text-xs text-[var(--ink-muted)]">
                      {ctx.locations.get(resource.location_id ?? "")?.name ?? "Any location"}
                      {!resource.active && " · inactive"}
                    </span>
                  </span>
                </label>
              ))}
              {resources.length === 0 && <p className="text-sm text-[var(--ink-secondary)]">No resources are configured.</p>}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-3 border-t border-[var(--rule-hairline)] pt-4">
            <ActionSubmit pendingLabel="Validating and saving…">Save service</ActionSubmit>
            <button type="reset" className="min-h-11 rounded-full border border-[var(--border-ring)] px-4 text-sm">Reset</button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Checkbox({ name, checked, children }: { name: string; checked: boolean; children: React.ReactNode }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} /> {children}
    </label>
  );
}
