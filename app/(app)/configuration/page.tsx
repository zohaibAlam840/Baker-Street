import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { ROLES, ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

/**
 * The administrator's view.
 *
 * The services table is the reason the engine is not ABA-specific: adding
 * podiatry should be rows here, not a change to the solver. Showing the
 * optimization profile as plain configuration makes that visible.
 */
export default async function ConfigurationPage() {
  await requirePermission("config.services");
  const { ctx, synthetic } = await loadHorizon({ startDate: defaultWeekStart() });

  const services = [...ctx.services.values()].sort(
    (a, b) =>
      a.department.localeCompare(b.department) ||
      a.service_name.localeCompare(b.service_name),
  );
  const resources = [...ctx.resources.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">Configuration</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--ink-secondary)]">
          Services, rooms and roles. Adding a new service should mean adding
          rows here — durations, who may deliver it, what room it needs, how it
          should be optimized — and nothing else.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">Services</h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--rule-hairline)]">
                <th className={thClass}>Service</th>
                <th className={thClass}>Department</th>
                <th className={thClass}>Durations</th>
                <th className={thClass}>Authorization</th>
                <th className={thClass}>Delivery</th>
                <th className={thClass}>Optimization objective</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr
                  key={service.id}
                  className="border-b border-[var(--rule-hairline)] last:border-0"
                >
                  <td className="px-3 py-2">
                    <span className="block text-[var(--ink-primary)]">
                      {service.service_name}
                    </span>
                    <span className="block text-xs text-[var(--ink-muted)]">
                      {service.service_code}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[var(--ink-secondary)]">
                    {service.department}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-[var(--ink-secondary)]">
                    {(ctx.serviceDurations.get(service.id) ?? []).join(", ")} min
                  </td>
                  <td className="px-3 py-2 text-[var(--ink-secondary)]">
                    {service.requires_authorization ? "Required" : "Not required"}
                  </td>
                  <td className="px-3 py-2 text-[var(--ink-secondary)]">
                    {[
                      service.in_person_allowed && "In person",
                      service.telehealth_allowed && "Telehealth",
                      service.group_allowed && "Group",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </td>
                  <td className="px-3 py-2">
                    <code className="text-xs text-[var(--ink-secondary)]">
                      {service.optimization_profile.primary_objective ?? "—"}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--ink-secondary)]">
          No row here is special-cased anywhere in the engine. ABA is the first
          service whose objective is demanding enough to prove the design, not a
          service the design is built around.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Rooms and equipment
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((resource) => (
            <li
              key={resource.id}
              className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3"
            >
              <span className="block text-sm text-[var(--ink-primary)]">
                {resource.name}
              </span>
              <span className="block text-xs text-[var(--ink-muted)]">
                {resource.resource_type} · holds {resource.capacity} ·{" "}
                {resource.location_id
                  ? (ctx.locations.get(resource.location_id)?.name ?? "—")
                  : "no location"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">Roles</h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--rule-hairline)]">
                <th className={thClass}>Role</th>
                <th className={thClass}>Sees</th>
                <th className={`${thClass} text-right`}>Permissions</th>
                <th className={`${thClass} text-right`}>Est. people</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => {
                const definition = ROLE_DEFINITIONS[role];
                return (
                  <tr
                    key={role}
                    className="border-b border-[var(--rule-hairline)] last:border-0"
                  >
                    <td className="px-3 py-2">
                      <span className="block text-[var(--ink-primary)]">
                        {definition.label}
                      </span>
                      <span className="block text-xs text-[var(--ink-muted)]">
                        {definition.summary}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--ink-secondary)]">
                      {definition.scope === "own"
                        ? "Own schedule"
                        : definition.scope === "caseload"
                          ? "Own caseload"
                          : definition.scope === "department"
                            ? "Own department"
                            : "Whole organisation"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {definition.permissions.length}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--ink-secondary)]">
                      {definition.headcount}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--ink-secondary)]">
          This role model is a proposal awaiting Baker Street&rsquo;s
          confirmation. User accounts arrive with real authentication
          {synthetic && " · synthetic data"}.
        </p>
      </section>
    </div>
  );
}

const thClass =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]";
