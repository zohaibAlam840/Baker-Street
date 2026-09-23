import Link from "next/link";

import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours } from "@/lib/domain/slots";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const { week } = await searchParams;
  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const weekStart = ctx.grid.startDate;
  const scope = ROLE_DEFINITIONS[session.role].scope;

  // "Own" and "caseload" scopes narrow to the provider this user is, and to
  // the patients they actually see. In the finished system this is enforced by
  // row-level security in Postgres as well — a UI filter is a convenience, not
  // a protection.
  const ownProviderId = session.providerId;
  const restricted = (scope === "own" || scope === "caseload") && ownProviderId != null;

  const myPatientIds = restricted
    ? new Set(
        (ctx.appointmentsByProvider.get(ownProviderId) ?? []).map((a) => a.patient_id),
      )
    : null;

  const patients = [...ctx.patients.values()]
    .filter((patient) => !myPatientIds || myPatientIds.has(patient.id))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  const providers = [...ctx.providers.values()]
    .filter((provider) => !restricted || provider.id === ownProviderId)
    .sort(
      (a, b) =>
        a.provider_type.localeCompare(b.provider_type) ||
        a.last_name.localeCompare(b.last_name),
    );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">Schedules</h1>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">
          Week of {weekStart}
          {restricted && " · your caseload"}
          {synthetic && " · synthetic data"}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          {restricted ? "Your patients" : "Patients"}
        </h2>
        {patients.length === 0 ? (
          <p className="text-sm text-[var(--ink-secondary)]">
            No patients on your schedule this week.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {patients.map((patient) => {
              const appointments = (ctx.appointmentsByPatient.get(patient.id) ?? []).filter(
                (a) => !restricted || a.provider_id === ownProviderId,
              );
              const hours = appointments.reduce(
                (total, a) => total + slotsToHours(a.range.endSlot - a.range.startSlot),
                0,
              );
              return (
                <li key={patient.id}>
                  <Link
                    href={`/schedule/patient/${patient.id}?week=${weekStart}`}
                    className="block rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3 transition-colors hover:bg-[var(--surface-sunken)]"
                  >
                    <span className="block text-sm font-medium text-[var(--ink-primary)]">
                      {patient.first_name} {patient.last_name}
                    </span>
                    <span className="block text-xs text-[var(--ink-muted)]">
                      {appointments.length} appointments · {hours}h
                      {restricted && " with you"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          {restricted ? "Your schedule" : "Providers"}
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => {
            const appointments = ctx.appointmentsByProvider.get(provider.id) ?? [];
            const hours = appointments.reduce(
              (total, a) => total + slotsToHours(a.range.endSlot - a.range.startSlot),
              0,
            );
            return (
              <li key={provider.id}>
                <Link
                  href={`/schedule/provider/${provider.id}?week=${weekStart}`}
                  className="block rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3 transition-colors hover:bg-[var(--surface-sunken)]"
                >
                  <span className="block text-sm font-medium text-[var(--ink-primary)]">
                    {provider.first_name} {provider.last_name}
                  </span>
                  <span className="block text-xs text-[var(--ink-muted)]">
                    {provider.provider_type} · {hours}h booked
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {restricted && (
        <p className="text-xs text-[var(--ink-secondary)]">
          You are seeing only your own schedule and the patients you work with.
          Schedulers and clinical supervisors see the full picture.
        </p>
      )}
    </div>
  );
}
