import Link from "next/link";

import { Card } from "@/components/charts";
import { ROLE_DEFINITIONS, can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours, subtractRanges } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; type?: string }>;
}) {
  const session = await requirePermission("view.provider_schedule");
  const { week, type } = await searchParams;
  const { ctx } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const definition = ROLE_DEFINITIONS[session.role];
  const restricted = definition.scope === "own" && session.providerId;

  const todayDate = ctx.grid.startDate;

  const rows = [...ctx.providers.values()]
    .filter((provider) => !restricted || provider.id === session.providerId)
    .filter((provider) => !type || provider.provider_type === type)
    .map((provider) => {
      const windows = ctx.providerClinicalWindows(provider.id);
      const booked = (ctx.appointmentsByProvider.get(provider.id) ?? []).map((a) => a.range);

      const available = windows.reduce(
        (total, w) => total + slotsToHours(w.endSlot - w.startSlot),
        0,
      );
      const used = booked.reduce(
        (total, r) => total + slotsToHours(r.endSlot - r.startSlot),
        0,
      );
      const open = subtractRanges(windows, booked).reduce(
        (total, w) => total + slotsToHours(w.endSlot - w.startSlot),
        0,
      );

      // A credential that has lapsed makes the clinician unbookable, whatever
      // their availability says — worth surfacing in the list, not just at
      // the point someone tries to book them.
      const credentials = ctx.providerCredentials.get(provider.id) ?? [];
      const lapsed = credentials.every(
        (c) => c.status !== "ACTIVE" || (c.expiration_date != null && c.expiration_date < todayDate),
      );

      const services = [...(ctx.providerServices.get(provider.id)?.values() ?? [])]
        .filter((link) => link.eligible)
        .map((link) => ctx.services.get(link.service_id)?.service_name)
        .filter((name): name is string => Boolean(name));

      return {
        provider,
        available,
        used,
        open,
        utilization: available > 0 ? Math.round((used / available) * 100) : 0,
        lapsed: credentials.length > 0 && lapsed,
        services,
        patients: new Set(
          (ctx.appointmentsByProvider.get(provider.id) ?? []).map((a) => a.patient_id),
        ).size,
      };
    })
    .sort(
      (a, b) =>
        a.provider.provider_type.localeCompare(b.provider.provider_type) ||
        b.utilization - a.utilization,
    );

  const types = [...new Set([...ctx.providers.values()].map((p) => p.provider_type))].sort();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
            Clinicians
          </h1>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            {rows.length} {rows.length === 1 ? "clinician" : "clinicians"} · week of{" "}
            {ctx.grid.startDate}
          </p>
        </div>

        {/* One filter row above everything it scopes. */}
        <div className="flex flex-wrap items-center gap-2">
        {can(session.role, "credentials.manage") && <Link href="/providers/new" className="rounded-full bg-[var(--brand)] px-3.5 py-2 text-sm font-medium text-white">Add clinician</Link>}
        <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <FilterChip href={`/providers?week=${ctx.grid.startDate}`} active={!type}>
            All
          </FilterChip>
          {types.map((t) => (
            <FilterChip
              key={t}
              href={`/providers?week=${ctx.grid.startDate}&type=${t}`}
              active={type === t}
            >
              {t}
            </FilterChip>
          ))}
        </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--ink-secondary)]">No clinicians match.</p>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <li key={row.provider.id}>
              <Link
                href={`/providers/${row.provider.id}?week=${ctx.grid.startDate}`}
                className="card block p-4 transition-shadow hover:shadow-[var(--shadow-float)]"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)] text-sm font-semibold text-[var(--ink-secondary)]"
                  >
                    {row.provider.first_name[0]}
                    {row.provider.last_name[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--ink-primary)]">
                      {row.provider.first_name} {row.provider.last_name}
                    </span>
                    <span className="block truncate text-xs text-[var(--ink-muted)]">
                      {row.provider.provider_type}
                      {row.services.length > 0 && ` · ${row.services[0]}`}
                    </span>
                  </span>
                </div>

                {/* Status never rests on colour: the dot is always labelled. */}
                {(row.provider.status !== "ACTIVE" || row.lapsed) && (
                  <p className="mt-3 flex items-center gap-1.5 text-[0.6875rem] text-[var(--ink-secondary)]">
                    <span
                      aria-hidden
                      className="inline-block size-1.5 rounded-full"
                      style={{ background: "var(--status-warning)" }}
                    />
                    {row.lapsed
                      ? "Credential lapsed — cannot be booked"
                      : row.provider.status.toLowerCase().replace("_", " ")}
                  </p>
                )}

                <div className="mt-4">
                  <div className="flex items-baseline justify-between text-[0.6875rem] text-[var(--ink-secondary)]">
                    <span>{Math.round(row.used)}h booked</span>
                    <span className="tabular-nums">{row.utilization}%</span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full"
                    style={{ background: "color-mix(in srgb, var(--brand) 18%, transparent)" }}
                    role="img"
                    aria-label={`${row.utilization}% utilized`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, row.utilization)}%`,
                        background: "var(--brand)",
                      }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-[0.6875rem] text-[var(--ink-muted)]">
                    <span>{Math.round(row.open)}h open</span>
                    <span>
                      {row.patients} {row.patients === 1 ? "patient" : "patients"}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={[
        "whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition-colors",
        active
          ? "border-transparent bg-[var(--brand)] font-medium text-white"
          : "border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-secondary)] hover:bg-[var(--surface-sunken)]",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}
