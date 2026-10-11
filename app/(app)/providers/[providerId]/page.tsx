import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { WeekGrid } from "@/components/schedule/WeekGrid";
import { AppointmentTable } from "@/components/schedule/tables";
import { IconArrowUpRight } from "@/components/shell/icons";
import { ROLE_DEFINITIONS, can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours, subtractRanges } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { buildWeekView } from "@/lib/scheduling/weekView";
import { addProviderCredential, addSupervisionRelationship } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The clinician record.
 *
 * Credentials, service eligibility and availability all decide whether this
 * person can be booked, and all three live only in the database until
 * something puts them on screen. A lapsed certification makes someone
 * unbookable however free their calendar looks — so it is stated at the top,
 * not buried in a list.
 */
export default async function ProviderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ providerId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const session = await requirePermission("view.provider_schedule");
  const { providerId } = await params;
  const { week } = await searchParams;

  const { ctx } = await loadHorizon({ startDate: week ?? defaultWeekStart() });
  const provider = ctx.providers.get(providerId);
  if (!provider) notFound();

  // A clinician scoped to their own schedule may only open their own record.
  const scope = ROLE_DEFINITIONS[session.role].scope;
  if (scope === "own" && session.providerId && session.providerId !== providerId) {
    notFound();
  }

  const appointments = ctx.appointmentsByProvider.get(providerId) ?? [];
  const windows = ctx.providerClinicalWindows(providerId);
  const view = buildWeekView(ctx, { subject: { kind: "provider", id: providerId } });

  const available = windows.reduce((t, w) => t + slotsToHours(w.endSlot - w.startSlot), 0);
  const booked = appointments.reduce(
    (t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot),
    0,
  );
  const open = subtractRanges(
    windows,
    appointments.map((a) => a.range),
  ).reduce((t, w) => t + slotsToHours(w.endSlot - w.startSlot), 0);
  const utilization = available > 0 ? Math.round((booked / available) * 100) : 0;

  const credentials = ctx.providerCredentials.get(providerId) ?? [];
  const weekEnd = ctx.grid.startDate;
  const liveCredential = credentials.some(
    (c) => c.status === "ACTIVE" && (!c.expiration_date || c.expiration_date >= weekEnd),
  );
  const unbookable = credentials.length > 0 && !liveCredential;

  const services = [...(ctx.providerServices.get(providerId)?.values() ?? [])]
    .filter((link) => link.eligible)
    .map((link) => ctx.services.get(link.service_id))
    .filter((s) => s != null);

  const rota = ctx.providerAvailability.get(providerId) ?? [];
  const week7 = [1, 2, 3, 4, 5, 6, 0].map((day) => ({
    day,
    label: WEEKDAYS[day],
    clinical: rota
      .filter(
        (r) =>
          r.day_of_week === day &&
          (r.availability_type === "CLINICAL" || r.availability_type === "PREFERRED"),
      )
      .map((r) => `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`),
    off: rota
      .filter(
        (r) =>
          r.day_of_week === day &&
          (r.availability_type === "PTO" || r.availability_type === "HARD_UNAVAILABLE"),
      )
      .map((r) => `${r.availability_type === "PTO" ? "PTO" : "Unavailable"}`),
  }));

  const patients = [
    ...new Map(
      appointments.map((a) => {
        const patient = ctx.patients.get(a.patient_id);
        return [
          a.patient_id,
          {
            id: a.patient_id,
            name: patient ? `${patient.first_name} ${patient.last_name}` : "Unknown",
            hours: 0,
          },
        ];
      }),
    ).values(),
  ].map((entry) => ({
    ...entry,
    hours: Math.round(
      appointments
        .filter((a) => a.patient_id === entry.id)
        .reduce((t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot), 0) * 10,
    ) / 10,
  }));

  return (
    <div className="space-y-4">
      <Link
        href="/providers"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)]"
      >
        ← All clinicians
      </Link>

      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className="grid size-14 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)] text-lg font-semibold text-[var(--ink-secondary)]"
          >
            {provider.first_name[0]}
            {provider.last_name[0]}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
              {provider.first_name} {provider.last_name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-secondary)]">
              <span>{provider.provider_type}</span>
              <span>{provider.external_id}</span>
              <span>
                {ctx.locations.get(provider.home_location_id ?? "")?.name ?? "No base"}
              </span>
            </p>
          </div>

          <Link
            href={`/schedule/provider/${providerId}?week=${ctx.grid.startDate}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-ring)] px-4 py-2.5 text-xs font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-sunken)]"
          >
            Full schedule
            <IconArrowUpRight className="size-3.5" />
          </Link>
        </div>

        {/* Bookability, stated before anything else it would contradict. */}
        {(unbookable || provider.status !== "ACTIVE") && (
          <p
            className="mt-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-relaxed"
            style={{
              background: "color-mix(in srgb, var(--status-warning) 12%, transparent)",
              color: "var(--ink-primary)",
            }}
          >
            <span
              aria-hidden
              className="mt-1 inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: "var(--status-warning)" }}
            />
            <span>
              {unbookable
                ? "Cannot be booked — no live credential covers this week, whatever their availability shows."
                : `Cannot be booked — ${provider.status.toLowerCase().replace("_", " ")}.`}
            </span>
          </p>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Booked</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {Math.round(booked)}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          <div
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "color-mix(in srgb, var(--brand) 16%, transparent)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, utilization)}%`,
                background: "var(--brand)",
              }}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            of {Math.round(available)}h clinical
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Utilization</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {utilization}%
          </div>
          <p
            className="mt-3 text-xs"
            style={{
              color: utilization >= 80 ? "var(--status-good)" : "var(--ink-muted)",
            }}
          >
            {utilization >= 80 ? "At or near capacity" : "Open capacity remains"}
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Open capacity</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {Math.round(open)}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">Unbooked clinical time</p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Patients</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {patients.length}
          </div>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            {appointments.length} appointments
          </p>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">This week</h2>
        <Card className="p-2">
          <WeekGrid view={view} />
        </Card>
        <p className="text-xs text-[var(--ink-muted)] lg:hidden">
          Swipe the calendar sideways to see the rest of the week.
        </p>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Credentials" sub="Checked at the moment of booking" />
          {credentials.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--ink-secondary)]">None recorded.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {credentials.map((credential) => {
                const expired =
                  credential.expiration_date != null &&
                  credential.expiration_date < weekEnd;
                return (
                  <li
                    key={credential.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5"
                  >
                    <span className="text-xs font-medium text-[var(--ink-primary)]">
                      {credential.credential_type}
                      {credential.state && ` · ${credential.state}`}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)]">
                      <span
                        aria-hidden
                        className="inline-block size-1.5 rounded-full"
                        style={{
                          background:
                            expired || credential.status !== "ACTIVE"
                              ? "var(--status-critical)"
                              : "var(--status-good)",
                        }}
                      />
                      {expired
                        ? `Expired ${credential.expiration_date}`
                        : credential.expiration_date
                          ? `Valid to ${credential.expiration_date}`
                          : "No expiry"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {can(session.role,"credentials.manage")&&<details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-[var(--brand)]">Add credential</summary><form action={addProviderCredential} className="mt-3 grid gap-3 sm:grid-cols-2"><input type="hidden" name="provider_id" value={providerId}/><input required name="credential_type" placeholder="Credential type" className="min-h-11 rounded-lg border px-3 text-sm"/><input name="credential_number" placeholder="Credential number" className="min-h-11 rounded-lg border px-3 text-sm"/><input name="state" placeholder="State" className="min-h-11 rounded-lg border px-3 text-sm"/><input name="issue_date" type="date" className="min-h-11 rounded-lg border px-3 text-sm"/><input name="expiration_date" type="date" className="min-h-11 rounded-lg border px-3 text-sm"/><select name="status" className="min-h-11 rounded-lg border px-3 text-sm"><option>ACTIVE</option><option>PENDING</option><option>SUSPENDED</option><option>EXPIRED</option></select><ActionSubmit className="sm:col-span-2" pendingLabel="Adding credential…">Add credential</ActionSubmit></form></details>}
          {can(session.role,"credentials.manage")&&<details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-[var(--brand)]">Assign supervisor</summary><form action={addSupervisionRelationship} className="mt-3 grid gap-3 sm:grid-cols-2"><input type="hidden" name="supervisee_id" value={providerId}/><select required name="supervisor_id" className="min-h-11 rounded-lg border px-3 text-sm"><option value="">Choose supervisor</option>{[...ctx.providers.values()].filter(p=>p.id!==providerId).map(p=><option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}</select><input name="effective_start" type="date" defaultValue={new Date().toISOString().slice(0,10)} className="min-h-11 rounded-lg border px-3 text-sm"/><ActionSubmit className="sm:col-span-2" pendingLabel="Assigning supervisor…">Assign supervisor</ActionSubmit></form></details>}

          <h3 className="mt-5 text-sm font-medium text-[var(--ink-primary)]">
            Eligible to deliver
          </h3>
          {services.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--ink-secondary)]">
              No services — cannot be booked for anything.
            </p>
          ) : (
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {services.map((service) => (
                <li
                  key={service.id}
                  className="rounded-full bg-[var(--brand-tint)] px-3 py-1.5 text-xs text-[var(--brand)]"
                >
                  {service.service_name}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Working hours" sub="What the engine treats as bookable" />
          {(can(session.role, "availability.manage") || (can(session.role, "availability.request") && session.providerId === provider.id)) && (
            <Link href={`/providers/${provider.id}/availability?week=${ctx.grid.startDate}`} className="mt-3 inline-block text-xs underline underline-offset-4">
              {can(session.role, "availability.manage") ? "Review availability and callouts" : "Report my callout"}
            </Link>
          )}
          <ul className="mt-3 divide-y divide-[var(--rule-hairline)]">
            {week7.map((day) => (
              <li key={day.day} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                <span className="w-20 shrink-0 text-xs font-medium text-[var(--ink-primary)]">
                  {day.label}
                </span>
                <span className="min-w-0 flex-1 text-xs">
                  {day.clinical.length === 0 ? (
                    <span className="text-[var(--ink-muted)]">Not working</span>
                  ) : (
                    <span className="tabular-nums text-[var(--ink-secondary)]">
                      {day.clinical.join(", ")}
                    </span>
                  )}
                  {day.off.length > 0 && (
                    <span className="mt-0.5 block text-[var(--ink-muted)]">
                      {day.off.join(", ")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {patients.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-[var(--ink-primary)]">Caseload</h2>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {patients
              .sort((a, b) => b.hours - a.hours)
              .map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={`/patients/${entry.id}?week=${ctx.grid.startDate}`}
                    className="card flex items-center gap-3 p-3 transition-shadow hover:shadow-[var(--shadow-float)]"
                  >
                    <span
                      aria-hidden
                      className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-xs font-semibold text-[var(--brand)]"
                    >
                      {entry.name
                        .split(" ")
                        .map((part) => part[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-primary)]">
                      {entry.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                      {entry.hours}h
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">Appointments</h2>
        <AppointmentTable view={view} />
      </section>
    </div>
  );
}
