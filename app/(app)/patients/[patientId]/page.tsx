import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { WeekGrid } from "@/components/schedule/WeekGrid";
import { ServiceSummaryTable } from "@/components/schedule/tables";
import { IconArrowUpRight, IconCalendar, IconSpark } from "@/components/shell/icons";
import { ROLE_DEFINITIONS, can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { formatClockTime, parseClockTime } from "@/lib/domain/time";
import { defaultWeekStart, demoToday } from "@/lib/scheduling/defaults";
import { summarisePatientWeek } from "@/lib/scheduling/summary";
import { buildWeekView } from "@/lib/scheduling/weekView";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The patient record.
 *
 * Everything the engine reasons about for one patient, in the order a
 * clinician asks for it: where they stand this week, what they need, when
 * they are actually free, and what is booked. Availability, restrictions and
 * preferences are in the schema and drive every decision, so they belong on
 * screen rather than only in the database.
 */
export default async function PatientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const { patientId } = await params;
  const { week } = await searchParams;

  const { ctx } = await loadHorizon({ startDate: week ?? defaultWeekStart() });
  const patient = ctx.patients.get(patientId);
  if (!patient) notFound();

  // A clinician scoped to their own caseload cannot open a patient they do
  // not see. Hiding the link is not enough — this is the check that matters.
  const scope = ROLE_DEFINITIONS[session.role].scope;
  if ((scope === "own" || scope === "caseload") && session.providerId) {
    const mine = (ctx.appointmentsByProvider.get(session.providerId) ?? []).some(
      (a) => a.patient_id === patientId,
    );
    if (!mine) notFound();
  }

  const summary = summarisePatientWeek(ctx, patientId);
  const view = buildWeekView(ctx, { subject: { kind: "patient", id: patientId } });
  const appointments = ctx.appointmentsByPatient.get(patientId) ?? [];

  const headline = summary.rows.find((r) => r.target_hours != null) ?? summary.rows[0];
  const totalHours = appointments.reduce(
    (t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot),
    0,
  );

  const today = demoToday();
  const next = appointments
    .filter((a) => ctx.grid.instantOf(a.range.startSlot) >= today)
    .sort((a, b) => a.range.startSlot - b.range.startSlot)[0];

  const age = patient.date_of_birth
    ? 2026 - Number(patient.date_of_birth.slice(0, 4))
    : null;

  // Availability and what blocks it, by weekday.
  const availability = ctx.patientAvailability.get(patientId) ?? [];
  const restrictions = ctx.patientRestrictions.get(patientId) ?? [];
  const week7 = [1, 2, 3, 4, 5, 6, 0].map((day) => ({
    day,
    label: WEEKDAYS[day],
    open: availability
      .filter((a) => a.day_of_week === day && a.availability_type !== "HARD_UNAVAILABLE")
      .map((a) => `${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`),
    blocked: restrictions
      .filter((r) => r.day_of_week === day)
      .map(
        (r) =>
          `${r.restriction_type.toLowerCase().replace("_", " ")} ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
      ),
  }));

  const preferences = ctx.patientPreferences.get(patientId) ?? [];
  const authorizations = ctx.authorizations.get(patientId) ?? [];

  return (
    <div className="space-y-4">
      <Link
        href="/patients"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)]"
      >
        ← All patients
      </Link>

      {/* ------------------------------- header ------------------------------- */}
      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className="grid size-14 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-lg font-semibold text-[var(--brand)]"
          >
            {patient.first_name[0]}
            {patient.last_name[0]}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
              {patient.first_name} {patient.last_name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-secondary)]">
              <span>{patient.external_id}</span>
              {age != null && <span>{age} years</span>}
              <span>
                {ctx.locations.get(patient.primary_location_id ?? "")?.name ?? "No base"}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background:
                      patient.status === "ACTIVE"
                        ? "var(--status-good)"
                        : "var(--status-warning)",
                  }}
                />
                {patient.status.charAt(0) + patient.status.slice(1).toLowerCase()}
              </span>
            </p>
          </div>

          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {can(session.role, "schedule.optimize") && (
              <Link
                href={`/optimize?patient=${patientId}&week=${ctx.grid.startDate}`}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-hover)] sm:flex-none"
              >
                <IconSpark className="size-4" />
                Fill service
              </Link>
            )}
            {can(session.role, "schedule.search_availability") && (
              <Link
                href={`/book?patient=${patientId}&week=${ctx.grid.startDate}`}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--border-ring)] px-4 py-2.5 text-xs font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-sunken)] sm:flex-none"
              >
                <IconCalendar className="size-4" />
                Find a time
              </Link>
            )}
          </div>
        </div>
      </Card>

      {/* -------------------------------- stats -------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">
            {headline?.service_name ?? "Scheduled"}
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {headline?.scheduled_hours ?? 0}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          {headline?.target_hours != null && (
            <>
              <div
                className="mt-3 h-1.5 w-full overflow-hidden rounded-full"
                style={{ background: "color-mix(in srgb, var(--brand) 16%, transparent)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (headline.scheduled_hours / headline.target_hours) * 100)}%`,
                    background: "var(--brand)",
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                Target {headline.target_hours}h
              </p>
            </>
          )}
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Required services</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {summary.required_services_met}/{summary.required_services_total}
          </div>
          <p
            className="mt-3 text-xs"
            style={{
              color:
                summary.required_services_met === summary.required_services_total
                  ? "var(--status-good)"
                  : "var(--status-warning)",
            }}
          >
            {summary.required_services_met === summary.required_services_total
              ? "All satisfied"
              : "One or more unmet"}
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">This week</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {appointments.length}
          </div>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            {Math.round(totalHours)}h across{" "}
            {new Set(appointments.map((a) => a.provider_id)).size} clinicians
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Next appointment</div>
          {next ? (
            <>
              <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
                {SHORT_DAYS[ctx.grid.weekdayOf(Math.floor(next.range.startSlot / SLOTS_PER_DAY))]}{" "}
                <span className="tabular-nums">
                  {formatClockTime((next.range.startSlot % SLOTS_PER_DAY) * SLOT_MINUTES)}
                </span>
              </div>
              <p className="mt-3 truncate text-xs text-[var(--ink-muted)]">
                {ctx.services.get(next.service_id)?.service_name}
              </p>
            </>
          ) : (
            <>
              <div className="mt-1 text-2xl font-semibold text-[var(--ink-muted)]">—</div>
              <p className="mt-3 text-xs text-[var(--ink-muted)]">
                Nothing left this week
              </p>
            </>
          )}
        </Card>
      </div>

      {/* ------------------------- requirements & week ------------------------- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Requirements and authorization
        </h2>
        <p className="max-w-3xl text-xs leading-relaxed text-[var(--ink-secondary)]">
          Scheduled, clinical minimum, target and authorized are four separate
          numbers. Authorization is what the payer will fund; it is never a
          statement of what the patient needs.
        </p>
        <ServiceSummaryTable rows={summary.rows} />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-[var(--ink-primary)]">This week</h2>
          <Link
            href={`/schedule/patient/${patientId}?week=${ctx.grid.startDate}`}
            className="inline-flex items-center gap-1 text-xs text-[var(--ink-secondary)] underline underline-offset-4"
          >
            Full schedule view
            <IconArrowUpRight className="size-3" />
          </Link>
        </div>
        <Card className="p-2">
          {/* Scrolls sideways on a phone rather than squashing the week. */}
          <WeekGrid view={view} />
        </Card>
        <p className="text-xs text-[var(--ink-muted)] lg:hidden">
          Swipe the calendar sideways to see the rest of the week.
        </p>
      </section>

      {/* --------------------- availability, prefs, payers --------------------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="When they can be seen"
            sub="Declared availability, and what blocks it"
          />
          <ul className="mt-4 divide-y divide-[var(--rule-hairline)]">
            {week7.map((day) => (
              <li key={day.day} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                <span className="w-20 shrink-0 text-xs font-medium text-[var(--ink-primary)]">
                  {day.label}
                </span>
                <span className="min-w-0 flex-1">
                  {day.open.length === 0 ? (
                    <span className="text-xs text-[var(--ink-muted)]">Not available</span>
                  ) : (
                    <span className="text-xs tabular-nums text-[var(--ink-secondary)]">
                      {day.open.join(", ")}
                    </span>
                  )}
                  {day.blocked.length > 0 && (
                    <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                      Blocked: {day.blocked.join(", ")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader title="Preferences" sub="Soft unless marked otherwise" />
            {preferences.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">
                None recorded.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {preferences.map((preference) => {
                  const parts: string[] = [];
                  if (preference.preferred_provider_id) {
                    const provider = ctx.providers.get(preference.preferred_provider_id);
                    if (provider) {
                      parts.push(`${provider.first_name} ${provider.last_name}`);
                    }
                  }
                  if (preference.preferred_location_id) {
                    parts.push(
                      ctx.locations.get(preference.preferred_location_id)?.name ?? "",
                    );
                  }
                  if (preference.preferred_day != null) {
                    parts.push(WEEKDAYS[preference.preferred_day]);
                  }
                  if (preference.preferred_start_time && preference.preferred_end_time) {
                    parts.push(
                      `${formatClockTime(parseClockTime(preference.preferred_start_time))}–${formatClockTime(
                        parseClockTime(preference.preferred_end_time),
                      )}`,
                    );
                  }
                  return (
                    <li
                      key={preference.id}
                      className="flex items-start justify-between gap-3 rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5"
                    >
                      <span className="min-w-0 text-xs text-[var(--ink-primary)]">
                        {preference.preferred_service_id
                          ? `${ctx.services.get(preference.preferred_service_id)?.service_name}: `
                          : ""}
                        {parts.filter(Boolean).join(" · ") || "No detail"}
                      </span>
                      <span className="shrink-0 text-[0.625rem] text-[var(--ink-muted)]">
                        {preference.is_hard_constraint ? "Required" : "Preferred"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Authorizations" sub="What the payer has approved" />
            {authorizations.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">
                None on file.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {authorizations.map((authorization) => {
                  const used = slotsToHours(
                    ctx.slotsUsedAgainstAuthorization(authorization.id),
                  );
                  return (
                    <li
                      key={authorization.id}
                      className="rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-xs font-medium text-[var(--ink-primary)]">
                          {ctx.services.get(authorization.service_id)?.service_name}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                          {used}h / {authorization.authorized_hours ?? "—"}h
                        </span>
                      </div>
                      <div className="mt-1 text-[0.625rem] text-[var(--ink-muted)]">
                        {authorization.payer ?? "No payer"} ·{" "}
                        {authorization.authorization_number ?? "no reference"} ·{" "}
                        {authorization.start_date} → {authorization.end_date}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
