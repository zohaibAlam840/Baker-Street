import Link from "next/link";

import { Card } from "@/components/charts";
import { IconArrowUpRight } from "@/components/shell/icons";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { addDays, formatClockTime, formatDateOnly } from "@/lib/domain/time";
import { defaultWeekStart, demoToday } from "@/lib/scheduling/defaults";
import { departmentSlot } from "@/lib/scheduling/weekView";

export const dynamic = "force-dynamic";

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The practice's week.
 *
 * This used to be a third list of patients and clinicians, which made three
 * navigation entries that all led to the same people — and the same card led
 * somewhere different depending on which list you came from. Schedules now
 * does what its name says: every appointment, by day, across the practice.
 * Patients and Clinicians own the people; this owns the time.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; day?: string; service?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const params = await searchParams;

  const { ctx } = await loadHorizon({ startDate: params.week ?? defaultWeekStart() });
  const weekStart = ctx.grid.startDate;

  const scope = ROLE_DEFINITIONS[session.role].scope;
  const restricted = (scope === "own" || scope === "caseload") && session.providerId;

  const all = restricted
    ? (ctx.appointmentsByProvider.get(session.providerId!) ?? [])
    : ctx.appointments;

  // Which day is open. Defaults to today when this week contains it.
  const todayDate = formatDateOnly(demoToday(), ctx.grid.timeZone);
  const todayIndex = [...Array(ctx.grid.dayCount).keys()].find(
    (i) => formatDateOnly(ctx.grid.dayStart(i), ctx.grid.timeZone) === todayDate,
  );
  const day = params.day != null ? Number(params.day) : (todayIndex ?? 0);

  const services = [...ctx.services.values()]
    .filter((s) => s.active)
    .sort((a, b) => a.service_name.localeCompare(b.service_name));

  const dayCounts = Array.from({ length: ctx.grid.dayCount }, (_, index) =>
    all.filter((a) => Math.floor(a.range.startSlot / SLOTS_PER_DAY) === index).length,
  );

  const rows = all
    .filter((a) => Math.floor(a.range.startSlot / SLOTS_PER_DAY) === day)
    .filter((a) => !params.service || a.service_id === params.service)
    .sort((a, b) => a.range.startSlot - b.range.startSlot)
    .map((a) => {
      const patient = ctx.patients.get(a.patient_id);
      const provider = a.provider_id ? ctx.providers.get(a.provider_id) : null;
      const service = ctx.services.get(a.service_id);
      const startMinutes = (a.range.startSlot % SLOTS_PER_DAY) * SLOT_MINUTES;
      return {
        id: a.id,
        patientId: a.patient_id,
        providerId: a.provider_id,
        patient: patient ? `${patient.first_name} ${patient.last_name}` : "Unknown",
        provider: provider ? `${provider.first_name} ${provider.last_name}` : "Unassigned",
        service: service?.service_name ?? "",
        departmentSlot: departmentSlot(service?.department ?? "Other"),
        location: a.location_id ? (ctx.locations.get(a.location_id)?.name ?? "—") : "—",
        time: `${formatClockTime(startMinutes)}–${formatClockTime(
          startMinutes + (a.range.endSlot - a.range.startSlot) * SLOT_MINUTES,
        )}`,
        hours: slotsToHours(a.range.endSlot - a.range.startSlot),
        status: a.status,
        flexibility: a.scheduling_flexibility,
      };
    });

  const dayHours = rows.reduce((t, r) => t + r.hours, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
            {restricted ? "Your schedule" : "Schedule"}
          </h1>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            Week of {weekStart} · {all.length} appointments
          </p>
        </div>

        <div className="flex items-center gap-1">
          <NavArrow href={`/schedule?week=${addDays(weekStart, -7)}`} label="Previous week">
            ←
          </NavArrow>
          <NavArrow href={`/schedule?week=${addDays(weekStart, 7)}`} label="Next week">
            →
          </NavArrow>
        </div>
      </div>

      {/* Day rail — the primary control, so it sits above everything it scopes. */}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {Array.from({ length: ctx.grid.dayCount }, (_, index) => {
          const date = formatDateOnly(ctx.grid.dayStart(index), ctx.grid.timeZone);
          const active = index === day;
          const isToday = index === todayIndex;
          return (
            <Link
              key={date}
              href={`/schedule?week=${weekStart}&day=${index}${
                params.service ? `&service=${params.service}` : ""
              }`}
              aria-current={active ? "page" : undefined}
              className="min-w-[4.5rem] shrink-0 rounded-2xl border px-3 py-2.5 text-center transition-colors"
              style={{
                background: active ? "var(--ink-primary)" : "var(--surface-1)",
                borderColor: active ? "transparent" : "var(--border-ring)",
                color: active ? "var(--surface-1)" : "var(--ink-primary)",
              }}
            >
              <span className="block text-[0.625rem] opacity-70">
                {SHORT_DAYS[ctx.grid.weekdayOf(index)]}
                {isToday && " · today"}
              </span>
              <span className="mt-0.5 block text-base font-semibold tabular-nums">
                {Number(date.slice(8))}
              </span>
              <span className="mt-0.5 block text-[0.625rem] tabular-nums opacity-70">
                {dayCounts[index]}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Service filter */}
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Chip href={`/schedule?week=${weekStart}&day=${day}`} active={!params.service}>
          All services
        </Chip>
        {services.map((service) => (
          <Chip
            key={service.id}
            href={`/schedule?week=${weekStart}&day=${day}&service=${service.id}`}
            active={params.service === service.id}
          >
            {service.service_name}
          </Chip>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--ink-secondary)]">
            Nothing scheduled{params.service ? " for that service" : ""} on this day.
          </p>
        </Card>
      ) : (
        <>
          <p className="text-xs text-[var(--ink-secondary)]">
            {rows.length} {rows.length === 1 ? "appointment" : "appointments"} ·{" "}
            {Math.round(dayHours)}h
          </p>

          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <Card className="p-0">
                  <div className="flex items-stretch gap-3">
                    {/* Department colour, carried on a bar rather than the text. */}
                    <span
                      aria-hidden
                      className={`dept-${row.departmentSlot} w-1 shrink-0 rounded-l-2xl`}
                      style={{ background: "var(--dept)" }}
                    />

                    {/* Stacks on a phone. Squeezing time, patient, clinician
                        and two badges onto one 414px line truncated every
                        field to three characters. */}
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-3 pr-3 sm:flex-row sm:items-center sm:gap-x-4">
                      <span className="flex items-center justify-between gap-3 sm:w-[6.5rem] sm:shrink-0">
                        <span className="text-xs tabular-nums text-[var(--ink-secondary)]">
                          {row.time}
                        </span>
                        {/* Badges ride with the time on mobile, right-aligned. */}
                        <span className="flex items-center gap-1.5 sm:hidden">
                          <Badges row={row} />
                        </span>
                      </span>

                      <span className="min-w-0 sm:flex-1">
                        <Link
                          href={`/patients/${row.patientId}?week=${weekStart}`}
                          className="block truncate text-sm font-medium text-[var(--ink-primary)] hover:underline"
                        >
                          {row.patient}
                        </Link>
                        <span className="block truncate text-xs text-[var(--ink-muted)]">
                          {row.service}
                        </span>
                      </span>

                      <span className="min-w-0 sm:w-44 sm:shrink-0">
                        {row.providerId ? (
                          <Link
                            href={`/providers/${row.providerId}?week=${weekStart}`}
                            className="block truncate text-xs text-[var(--ink-secondary)] hover:underline"
                          >
                            {row.provider}
                          </Link>
                        ) : (
                          <span className="block truncate text-xs text-[var(--ink-muted)]">
                            {row.provider}
                          </span>
                        )}
                        <span className="block truncate text-[0.625rem] text-[var(--ink-muted)]">
                          {row.location}
                        </span>
                      </span>

                      <span className="flex shrink-0 items-center gap-1.5">
                        <Badges row={row} />
                        <Link href={`/appointments/${row.id}?week=${weekStart}`} className="ml-2 text-xs underline underline-offset-4">Details</Link>
                      </span>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ink-secondary)]">
        Looking for one person&rsquo;s week?
        <Link href="/patients" className="inline-flex items-center gap-1 underline underline-offset-4">
          Patients
          <IconArrowUpRight className="size-3" />
        </Link>
        <Link href="/providers" className="inline-flex items-center gap-1 underline underline-offset-4">
          Clinicians
          <IconArrowUpRight className="size-3" />
        </Link>
      </p>
    </div>
  );
}

/** Flexibility and status, rendered the same in both layouts. */
function Badges({
  row,
}: {
  row: { flexibility: string; status: string };
}) {
  return (
    <>
      {row.flexibility !== "FLEXIBLE" && (
        <span
          title={
            row.flexibility === "LOCKED"
              ? "Locked — cannot be moved"
              : "Protected — movable only at high cost"
          }
          className="whitespace-nowrap rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[0.625rem] text-[var(--ink-secondary)]"
        >
          {row.flexibility === "LOCKED" ? "Locked" : "Protected"}
        </span>
      )}
      <span
        className="whitespace-nowrap rounded-full px-2 py-0.5 text-[0.625rem] font-medium"
        style={{
          background:
            row.status === "COMPLETED" ? "var(--surface-sunken)" : "var(--brand-tint)",
          color: row.status === "COMPLETED" ? "var(--ink-secondary)" : "var(--brand)",
        }}
      >
        {row.status === "COMPLETED" ? "Done" : "Upcoming"}
      </span>
    </>
  );
}

function NavArrow({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="grid size-9 place-items-center rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-primary)]"
    >
      {children}
    </Link>
  );
}

function Chip({
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
