import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { formatClockTime, formatDateOnly } from "@/lib/domain/time";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * What the top bar's search box actually does.
 *
 * That box sat on every screen with no form around it and no name on the
 * input: typing in it and pressing Enter did nothing. Its placeholder
 * promised patients, clinicians and appointments, so this searches all three
 * rather than quietly narrowing the promise to one of them.
 *
 * Scope is enforced here, not just in what gets rendered: a therapist
 * searching finds their own patients and themselves, and nobody else.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; week?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const { q, week } = await searchParams;
  const query = (q ?? "").trim();

  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });
  const weekStart = ctx.grid.startDate;

  const scope = ROLE_DEFINITIONS[session.role].scope;
  const restricted = synthetic && (scope === "own" || scope === "caseload") && session.providerId;

  // The caseload a scoped user may see at all.
  const ownAppointments = session.providerId
    ? (ctx.appointmentsByProvider.get(session.providerId) ?? [])
    : [];
  const caseload = new Set(ownAppointments.map((a) => a.patient_id));

  const needle = query.toLowerCase();
  const matches = (...fields: (string | null | undefined)[]) =>
    needle.length > 0 &&
    fields.some((field) => (field ?? "").toLowerCase().includes(needle));

  const patients = [...ctx.patients.values()]
    .filter((p) => !restricted || caseload.has(p.id))
    .filter((p) =>
      matches(`${p.first_name} ${p.last_name}`, p.external_id, p.status),
    )
    .slice(0, 12);

  const providers = [...ctx.providers.values()]
    .filter((p) => !restricted || p.id === session.providerId)
    .filter((p) =>
      matches(`${p.first_name} ${p.last_name}`, p.provider_type, p.external_id),
    )
    .slice(0, 12);

  const visibleAppointments = restricted ? ownAppointments : ctx.appointments;
  const appointments = visibleAppointments
    .filter((a) => {
      const patient = ctx.patients.get(a.patient_id);
      const provider = a.provider_id ? ctx.providers.get(a.provider_id) : null;
      const service = ctx.services.get(a.service_id);
      return matches(
        patient ? `${patient.first_name} ${patient.last_name}` : null,
        provider ? `${provider.first_name} ${provider.last_name}` : null,
        service?.service_name,
        service?.service_code,
      );
    })
    .sort((a, b) => a.range.startSlot - b.range.startSlot)
    .slice(0, 15);

  const total = patients.length + providers.length + appointments.length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Search
        </h1>
        <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
          {query
            ? `${total} ${total === 1 ? "result" : "results"} for “${query}” · week of ${weekStart}`
            : `Patients, clinicians and appointments · week of ${weekStart}`}
          {restricted && " · limited to your caseload"}
        </p>
      </div>

      <form className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <input
          type="search"
          name="q"
          defaultValue={query}
          autoFocus
          placeholder="Name, ID or service"
          className="h-11 min-w-0 flex-1 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-4 text-sm outline-none placeholder:text-[var(--ink-muted)] focus:ring-2 focus:ring-[var(--brand-ring)]"
        />
        <input type="hidden" name="week" value={weekStart} />
        <button
          type="submit"
          className="h-11 shrink-0 rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Search
        </button>
      </form>

      {query && total === 0 && (
        <Card>
          <p className="text-sm text-[var(--ink-secondary)]">
            Nothing matched “{query}”.
            {restricted &&
              " You can only search the patients you see and your own record."}
          </p>
        </Card>
      )}

      {patients.length > 0 && (
        <Card>
          <CardHeader title="Patients" sub={`${patients.length} matching`} />
          <ul className="mt-3 divide-y divide-[var(--rule-hairline)]">
            {patients.map((patient) => {
              const hours = (ctx.appointmentsByPatient.get(patient.id) ?? []).reduce(
                (t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot),
                0,
              );
              return (
                <li key={patient.id}>
                  <Link
                    href={`/patients/${patient.id}?week=${weekStart}`}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--surface-sunken)]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-[var(--ink-primary)]">
                        {patient.first_name} {patient.last_name}
                      </span>
                      <span className="block truncate text-xs text-[var(--ink-muted)]">
                        {patient.external_id ?? "—"} · {patient.status.toLowerCase()}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                      {Math.round(hours)}h this week
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {providers.length > 0 && (
        <Card>
          <CardHeader title="Clinicians" sub={`${providers.length} matching`} />
          <ul className="mt-3 divide-y divide-[var(--rule-hairline)]">
            {providers.map((provider) => (
              <li key={provider.id}>
                <Link
                  href={`/providers/${provider.id}?week=${weekStart}`}
                  className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--surface-sunken)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-[var(--ink-primary)]">
                      {provider.first_name} {provider.last_name}
                    </span>
                    <span className="block truncate text-xs text-[var(--ink-muted)]">
                      {provider.provider_type} · {provider.status.toLowerCase()}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                    {(ctx.appointmentsByProvider.get(provider.id) ?? []).length} appts
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {appointments.length > 0 && (
        <Card>
          <CardHeader title="Appointments" sub={`${appointments.length} matching`} />
          <ul className="mt-3 divide-y divide-[var(--rule-hairline)]">
            {appointments.map((appointment) => {
              const patient = ctx.patients.get(appointment.patient_id);
              const provider = appointment.provider_id
                ? ctx.providers.get(appointment.provider_id)
                : null;
              const service = ctx.services.get(appointment.service_id);
              const day = Math.floor(appointment.range.startSlot / SLOTS_PER_DAY);
              const startMinutes =
                (appointment.range.startSlot % SLOTS_PER_DAY) * SLOT_MINUTES;
              return (
                <li key={appointment.id}>
                  <Link
                    href={`/appointments/${appointment.id}?week=${weekStart}`}
                    className="-mx-2 flex flex-col gap-1 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--surface-sunken)] sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-[var(--ink-primary)]">
                        {patient ? `${patient.first_name} ${patient.last_name}` : "—"}
                        {" · "}
                        {service?.service_name}
                      </span>
                      <span className="block truncate text-xs text-[var(--ink-muted)]">
                        {provider
                          ? `${provider.first_name} ${provider.last_name}`
                          : "Unassigned"}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                      {WEEKDAYS[ctx.grid.weekdayOf(day)]}{" "}
                      {formatClockTime(startMinutes)} ·{" "}
                      {formatDateOnly(ctx.grid.dayStart(day), ctx.grid.timeZone)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {!query && (
        <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
          Searches names, IDs and service names across the loaded week. It reads
          the same snapshot every other screen does, so there is no separate
          index to fall out of date.
        </p>
      )}
    </div>
  );
}
