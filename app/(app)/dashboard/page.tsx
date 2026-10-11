import Link from "next/link";

import {
  AreaChart,
  Card,
  MultiLineChart,
  SegmentBar,
  VerticalBars,
} from "@/components/charts";
import {
  IconArrowUpRight,
  IconCalendar,
  IconChart,
  IconStethoscope,
  IconUsers,
} from "@/components/shell/icons";
import { OversightOverview } from "@/components/dashboard/OversightOverview";
import { can } from "@/lib/auth/roles";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours, subtractRanges } from "@/lib/domain/slots";
import { formatClockTime, formatDateOnly } from "@/lib/domain/time";
import { defaultWeekStart, demoToday } from "@/lib/scheduling/defaults";
import { addDays } from "@/lib/domain/time";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; clinician?: string }>;
}) {
  const session = await requireSession();
  const definition = ROLE_DEFINITIONS[session.role];
  const { week, clinician } = await searchParams;
  const weekStart = week ?? defaultWeekStart();

  // A role that cannot see a schedule has no business being shown one. The
  // compliance officer holds `audit.read` and nothing else, and was landing
  // on the full clinical dashboard — patient demographics included.
  if (
    !can(session.role, "view.patient_schedule") &&
    !can(session.role, "view.provider_schedule")
  ) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("oversight_metrics", {
      p_date_start: weekStart,
      p_date_end: addDays(weekStart, 6),
    });
    const metrics = (data ?? {}) as {
      appointments?: number;
      services?: number;
      locations?: number;
      overrides?: number;
      audit_entries?: number;
    };
    return (
      <OversightOverview
        roleLabel={definition.label}
        weekStart={weekStart}
        appointments={metrics.appointments ?? 0}
        services={metrics.services ?? 0}
        locations={metrics.locations ?? 0}
        overrides={metrics.overrides ?? 0}
        auditEntries={metrics.audit_entries ?? 0}
      />
    );
  }

  const { ctx } = await loadHorizon({ startDate: weekStart });

  const today = demoToday();
  const todayDate = formatDateOnly(today, ctx.grid.timeZone);
  const todayIndex =
    [...Array(ctx.grid.dayCount).keys()].find(
      (i) => formatDateOnly(ctx.grid.dayStart(i), ctx.grid.timeZone) === todayDate,
    ) ?? 0;

  // A therapist's dashboard is their own day, not the practice's.
  const scoped = definition.scope === "own" && session.providerId;
  const visible = scoped
    ? (ctx.appointmentsByProvider.get(session.providerId!) ?? [])
    : ctx.appointments;

  // ------------------------------------------------------------------ stats
  const patients = [...ctx.patients.values()];
  const activePatients = patients.filter((p) => p.status === "ACTIVE").length;
  const providers = [...ctx.providers.values()];
  const availableProviders = providers.filter((p) => p.status === "ACTIVE").length;

  const todays = visible.filter(
    (a) => Math.floor(a.range.startSlot / SLOTS_PER_DAY) === todayIndex,
  );
  const completedToday = todays.filter((a) => a.status === "COMPLETED").length;

  let authorized = 0;
  let usedAgainstAuth = 0;
  for (const list of ctx.authorizations.values()) {
    for (const auth of list) {
      if (auth.status !== "ACTIVE" || auth.authorized_hours == null) continue;
      authorized += auth.authorized_hours;
      usedAgainstAuth += slotsToHours(ctx.slotsUsedAgainstAuthorization(auth.id));
    }
  }

  const myHours = visible.reduce(
    (t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot),
    0,
  );
  const myAvailable = session.providerId
    ? ctx
        .providerClinicalWindows(session.providerId)
        .reduce((t, w) => t + slotsToHours(w.endSlot - w.startSlot), 0)
    : 0;

  // ------------------------------------------------------------ trend data
  const perDay = Array.from({ length: ctx.grid.dayCount }, (_, day) =>
    visible.filter((a) => Math.floor(a.range.startSlot / SLOTS_PER_DAY) === day).length,
  );
  const dayLabels = Array.from({ length: ctx.grid.dayCount }, (_, i) =>
    DAY_LABELS[ctx.grid.weekdayOf(i)],
  );
  const weekTotal = perDay.reduce((a, b) => a + b, 0);
  const upcoming = visible.filter((a) => a.status !== "COMPLETED").length;
  const completed = visible.length - upcoming;

  // Hours per day for the three biggest services — the multi-line panel.
  const serviceTotals = new Map<string, number>();
  for (const a of visible) {
    const id = a.service_id;
    serviceTotals.set(
      id,
      (serviceTotals.get(id) ?? 0) + slotsToHours(a.range.endSlot - a.range.startSlot),
    );
  }
  const topServices = [...serviceTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id], index) => ({
      label: (ctx.services.get(id)?.service_name ?? "").split(" ")[0],
      color: [`var(--brand)`, `var(--dept-2)`, `var(--dept-1)`][index],
      values: Array.from({ length: ctx.grid.dayCount }, (_, day) =>
        Math.round(
          visible
            .filter(
              (a) =>
                a.service_id === id &&
                Math.floor(a.range.startSlot / SLOTS_PER_DAY) === day,
            )
            .reduce((t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot), 0),
        ),
      ),
    }));
  const totalHours = [...serviceTotals.values()].reduce((a, b) => a + b, 0);

  // -------------------------------------------------- clinician schedule panel
  const bookableProviders = providers.filter(
    (p) => p.status === "ACTIVE" && (ctx.appointmentsByProvider.get(p.id)?.length ?? 0) > 0,
  );
  const focusProvider =
    (scoped ? providers.find((p) => p.id === session.providerId) : undefined) ??
    bookableProviders.find((p) => p.id === clinician) ??
    bookableProviders[0];

  const focusAppointments = focusProvider
    ? (ctx.appointmentsByProvider.get(focusProvider.id) ?? [])
    : [];
  const focusWindows = focusProvider ? ctx.providerClinicalWindows(focusProvider.id) : [];
  const focusAvailable = focusWindows.reduce(
    (t, w) => t + slotsToHours(w.endSlot - w.startSlot),
    0,
  );
  const focusBooked = focusAppointments.reduce(
    (t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot),
    0,
  );
  const focusOpen = subtractRanges(
    focusWindows,
    focusAppointments.map((a) => a.range),
  ).reduce((t, w) => t + slotsToHours(w.endSlot - w.startSlot), 0);

  // The hour chips for the focused clinician on today, with booked ones marked.
  const todayWindows = focusWindows.filter(
    (w) => Math.floor(w.startSlot / SLOTS_PER_DAY) === todayIndex,
  );
  const hourChips: { label: string; booked: boolean }[] = [];
  for (const window of todayWindows) {
    for (let slot = window.startSlot; slot + 4 <= window.endSlot; slot += 4) {
      const booked = focusAppointments.some(
        (a) => a.range.startSlot <= slot && slot < a.range.endSlot,
      );
      hourChips.push({
        label: formatClockTime((slot % SLOTS_PER_DAY) * SLOT_MINUTES),
        booked,
      });
    }
  }

  const focusPatients = new Set(focusAppointments.map((a) => a.patient_id));
  const focusUpcoming = focusAppointments.filter((a) => a.status !== "COMPLETED").length;

  const focusToday = focusAppointments
    .filter((a) => Math.floor(a.range.startSlot / SLOTS_PER_DAY) === todayIndex)
    .sort((a, b) => a.range.startSlot - b.range.startSlot)
    .slice(0, 5)
    .map((a) => {
      const patient = ctx.patients.get(a.patient_id);
      const name = patient ? `${patient.first_name} ${patient.last_name}` : "Unknown";
      return {
        id: a.id,
        patientId: a.patient_id,
        patient: name,
        initials: name
          .split(" ")
          .map((part) => part[0])
          .slice(0, 2)
          .join(""),
        service: ctx.services.get(a.service_id)?.service_name ?? "",
        time: formatClockTime((a.range.startSlot % SLOTS_PER_DAY) * SLOT_MINUTES),
      };
    });

  // ------------------------------------------------------------ demographics
  // A therapist sees the age spread of *their* patients. The practice-wide
  // figure was still here after the other scoping fixes: a clinician with one
  // patient this week was being shown all 20.
  const cohortIds = new Set(visible.map((a) => a.patient_id));
  const cohort = scoped ? patients.filter((p) => cohortIds.has(p.id)) : patients;
  const cohortActive = cohort.filter((p) => p.status === "ACTIVE").length;
  const bands = ageBands(cohort);
  const biggest = bands.reduce(
    (best, band, index) => (band.count > bands[best].count ? index : best),
    0,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
            Overview
          </h1>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            {scoped ? "Your day" : "Across the practice"} ·{" "}
            {today.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        {can(session.role, "schedule.optimize") && (
          <Link
            href="/optimize"
            className="rounded-full bg-[var(--brand)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
          >
            Fill a service
          </Link>
        )}
      </div>

      {/* ------------------------------- stat row ------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {scoped ? (
          <>
            <StatCard
              label="Your patients"
              value={String(focusPatients.size)}
              icon={<IconUsers className="size-[18px]" />}
            >
              <p className="mt-4 text-xs text-[var(--ink-muted)]">Seen by you this week</p>
            </StatCard>
            <StatCard
              label="Your hours"
              value={String(Math.round(myHours))}
              unit="h"
              icon={<IconCalendar className="size-[18px]" />}
            >
              <SegmentBar
                value={myHours}
                total={Math.max(myAvailable, 1)}
                leftLabel="Booked"
                rightLabel="Open"
                leftValue={`${Math.round(myHours)}h`}
                rightValue={`${Math.round(Math.max(0, myAvailable - myHours))}h`}
              />
            </StatCard>
          </>
        ) : (
          <>
            <StatCard
              label="Total patients"
              value={String(patients.length)}
              icon={<IconUsers className="size-[18px]" />}
            >
              <SegmentBar
                value={activePatients}
                total={patients.length}
                leftLabel="Active"
                rightLabel="Inactive"
                leftValue={String(activePatients)}
                rightValue={String(patients.length - activePatients)}
              />
            </StatCard>
            <StatCard
              label="Clinicians"
              value={String(providers.length)}
              icon={<IconStethoscope className="size-[18px]" />}
            >
              <SegmentBar
                value={availableProviders}
                total={providers.length}
                leftLabel="Available"
                rightLabel="On leave"
                leftValue={String(availableProviders)}
                rightValue={String(providers.length - availableProviders)}
                color="var(--dept-1)"
              />
            </StatCard>
          </>
        )}

        <StatCard
          label="Today's appointments"
          value={String(todays.length)}
          icon={<IconCalendar className="size-[18px]" />}
        >
          <SegmentBar
            value={completedToday}
            total={Math.max(todays.length, 1)}
            leftLabel="Completed"
            rightLabel="Upcoming"
            leftValue={String(completedToday)}
            rightValue={String(todays.length - completedToday)}
            color="var(--dept-2)"
          />
        </StatCard>

        {scoped ? (
          <StatCard
            label="This week"
            value={String(visible.length)}
            icon={<IconChart className="size-[18px]" />}
          >
            <p className="mt-4 text-xs text-[var(--ink-muted)]">
              Appointments on your schedule
            </p>
          </StatCard>
        ) : (
          <StatCard
            label="Authorized hours"
            value={String(Math.round(authorized))}
            unit="h"
            icon={<IconChart className="size-[18px]" />}
          >
            <SegmentBar
              value={usedAgainstAuth}
              total={Math.max(authorized, 1)}
              leftLabel="Scheduled"
              rightLabel="Unused"
              leftValue={`${Math.round(usedAgainstAuth)}h`}
              rightValue={`${Math.round(Math.max(0, authorized - usedAgainstAuth))}h`}
            />
          </StatCard>
        )}
      </div>

      {/* ------------- middle + lower, with the schedule panel spanning ------------- */}
      <div className="grid gap-3 xl:grid-cols-[1.35fr_1fr_1fr]">
        {/* Appointments trend */}
        <Card className="xl:col-span-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-[var(--ink-primary)]">
              Appointment trends
            </h2>
            <Link
              href="/schedule"
              aria-label="Open schedules"
              className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--border-ring)] text-[var(--ink-secondary)]"
            >
              <IconArrowUpRight className="size-4" />
            </Link>
          </div>

          <p className="mt-3 text-xs text-[var(--ink-secondary)]">This week</p>
          <p className="text-2xl font-semibold text-[var(--ink-primary)]">{weekTotal}</p>

          <div className="mt-3 flex gap-2">
            <Pill value={completed} label="Completed" />
            <Pill value={upcoming} label="Upcoming" />
          </div>

          <div className="mt-4">
            <AreaChart
              values={perDay}
              labels={dayLabels}
              highlight={todayIndex}
              badge={`${perDay[todayIndex] ?? 0} today`}
              height={120}
              caption={`Appointments per day: ${perDay
                .map((v, i) => `${dayLabels[i]} ${v}`)
                .join(", ")}`}
            />
          </div>
        </Card>

        {/* Service mix — the reference's second chart is revenue; we have hours. */}
        <Card>
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-[var(--ink-primary)]">
              Service mix
            </h2>
            <Link
              href="/capacity"
              aria-label="Open capacity"
              className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--border-ring)] text-[var(--ink-secondary)]"
            >
              <IconArrowUpRight className="size-4" />
            </Link>
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-xs">
            <span aria-hidden style={{ color: "var(--status-good)" }}>
              ↗
            </span>
            <span className="text-[var(--ink-secondary)]">
              {Math.round(totalHours)}h delivered this week
            </span>
          </p>

          <div className="mt-4">
            <MultiLineChart series={topServices} labels={dayLabels} height={140} />
          </div>
        </Card>

        {/* Clinician schedule — spans both rows, as the reference does */}
        <Card className="xl:row-span-2">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-[var(--ink-primary)]">
              {scoped ? "Your schedule" : "Clinician schedule"}
            </h2>
            {focusProvider && (
              <Link
                href={`/providers/${focusProvider.id}?week=${ctx.grid.startDate}`}
                aria-label="Open this clinician's week"
                className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--border-ring)] text-[var(--ink-secondary)]"
              >
                <IconArrowUpRight className="size-4" />
              </Link>
            )}
          </div>

          {!focusProvider ? (
            <p className="mt-4 text-sm text-[var(--ink-secondary)]">
              Nobody has appointments this week.
            </p>
          ) : (
            <>
              <div className="mt-4 flex items-baseline justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-[var(--ink-primary)]">
                    {focusProvider.first_name} {focusProvider.last_name}
                  </div>
                  <div className="text-xs text-[var(--ink-muted)]">
                    {focusProvider.provider_type}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold text-[var(--ink-primary)]">
                    {ctx.locations.get(focusProvider.home_location_id ?? "")?.name ?? "—"}
                  </div>
                  <div className="text-xs text-[var(--ink-muted)]">Base</div>
                </div>
              </div>

              {/* Date rail */}
              <h3 className="mt-5 text-sm font-medium text-[var(--ink-primary)]">Week</h3>
              <ul className="no-scrollbar mt-2.5 flex gap-1.5 overflow-x-auto">
                {Array.from({ length: ctx.grid.dayCount }, (_, day) => {
                  const date = formatDateOnly(ctx.grid.dayStart(day), ctx.grid.timeZone);
                  const count = focusAppointments.filter(
                    (a) => Math.floor(a.range.startSlot / SLOTS_PER_DAY) === day,
                  ).length;
                  const isToday = day === todayIndex;
                  return (
                    <li key={date}>
                      <span
                        title={`${date}: ${count} appointments`}
                        className="grid size-9 place-items-center rounded-full text-xs font-medium"
                        style={{
                          background: isToday
                            ? "var(--ink-primary)"
                            : count > 0
                              ? "var(--brand-tint)"
                              : "var(--surface-sunken)",
                          color: isToday
                            ? "var(--surface-1)"
                            : count > 0
                              ? "var(--brand)"
                              : "var(--ink-muted)",
                        }}
                      >
                        {Number(date.slice(8))}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/* Hour chips for today */}
              <h3 className="mt-5 text-sm font-medium text-[var(--ink-primary)]">
                Today
              </h3>
              {hourChips.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--ink-muted)]">
                  Not working today.
                </p>
              ) : (
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {hourChips.map((chip, index) => (
                    <li key={`${chip.label}-${index}`}>
                      <span
                        className="inline-block rounded-full px-2.5 py-1.5 text-[0.6875rem] tabular-nums"
                        style={{
                          background: chip.booked
                            ? "var(--ink-primary)"
                            : "var(--surface-sunken)",
                          color: chip.booked
                            ? "var(--surface-1)"
                            : "var(--ink-secondary)",
                        }}
                      >
                        {chip.label}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[0.625rem] text-[var(--ink-muted)]">
                Filled chips are booked; the rest are open.
              </p>

              {/* Utilization */}
              <h3 className="mt-5 text-sm font-medium text-[var(--ink-primary)]">
                Utilization
              </h3>
              <div
                className="mt-2.5 h-2 w-full overflow-hidden rounded-full"
                style={{ background: "color-mix(in srgb, var(--brand) 16%, transparent)" }}
                role="img"
                aria-label={`${Math.round(focusBooked)} of ${Math.round(focusAvailable)} hours booked`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (focusBooked / Math.max(focusAvailable, 1)) * 100)}%`,
                    background: "var(--brand)",
                  }}
                />
              </div>
              <div className="mt-2 flex justify-between text-xs tabular-nums text-[var(--ink-secondary)]">
                <span>{Math.round(focusBooked)}h booked</span>
                <span className="text-[var(--ink-muted)]">
                  {Math.round(focusOpen)}h open
                </span>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <Mini
                  value={focusUpcoming}
                  label="Upcoming"
                  color="var(--brand)"
                />
                <Mini
                  value={focusPatients.size}
                  label="Patients"
                  color="var(--dept-2)"
                />
              </div>

              {/* Their actual day, which is what a clinician opens this for. */}
              <h3 className="mt-5 text-sm font-medium text-[var(--ink-primary)]">
                Appointments today
              </h3>
              {focusToday.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--ink-muted)]">
                  Nothing booked today.
                </p>
              ) : (
                <ul className="mt-2.5 divide-y divide-[var(--rule-hairline)]">
                  {focusToday.map((item) => (
                    <li key={item.id} className="flex items-center gap-2.5 py-2.5">
                      <span
                        aria-hidden
                        className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)] text-[0.625rem] font-semibold text-[var(--ink-secondary)]"
                      >
                        {item.initials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <Link
                          href={`/patients/${item.patientId}?week=${ctx.grid.startDate}`}
                          className="block truncate text-xs font-medium text-[var(--ink-primary)]"
                        >
                          {item.patient}
                        </Link>
                        <span className="block truncate text-[0.625rem] text-[var(--ink-muted)]">
                          {item.service}
                        </span>
                      </span>
                      <span className="shrink-0 text-[0.625rem] tabular-nums text-[var(--ink-secondary)]">
                        {item.time}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>

        {/* Patient demographic — spans the two left columns */}
        <Card className="xl:col-span-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-[0.9375rem] font-semibold tracking-tight text-[var(--ink-primary)]">
                Patient demographic
              </h2>
              <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                <span className="text-lg font-semibold text-[var(--ink-primary)]">
                  {cohort.length}
                </span>{" "}
                {scoped ? "of your patients" : "total patients"} · {cohortActive} active
              </p>
            </div>
            <Link
              href="/patients"
              aria-label="Open patients"
              className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--border-ring)] text-[var(--ink-secondary)]"
            >
              <IconArrowUpRight className="size-4" />
            </Link>
          </div>

          <div className="mt-5">
            <VerticalBars
              highlight={biggest}
              bands={bands.map((band) => ({
                label: band.label,
                caption: "Patients",
                value: band.count,
                share: (band.count / Math.max(cohort.length, 1)) * 100,
              }))}
            />
          </div>

          <p className="mt-4 text-[0.6875rem] leading-relaxed text-[var(--ink-muted)]">
            Age drives which services apply and when a patient is free — school
            hours for children, work hours for adults.
          </p>
        </Card>
      </div>
    </div>
  );
}

/** A stat card with the metric icon in the corner, as the reference draws it. */
function StatCard({
  label,
  value,
  unit,
  icon,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-[var(--ink-secondary)]">{label}</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-semibold leading-none text-[var(--ink-primary)]">
              {value}
            </span>
            {unit && <span className="text-sm text-[var(--ink-muted)]">{unit}</span>}
          </div>
        </div>
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-secondary)]"
        >
          {icon}
        </span>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Pill({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-center gap-2 rounded-xl bg-[var(--surface-sunken)] px-3 py-2">
      <span className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
        {value}
      </span>
      <span className="text-xs text-[var(--ink-secondary)]">{label}</span>
    </span>
  );
}

function Mini({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="rounded-xl bg-[var(--surface-sunken)] p-3">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full"
          style={{ background: color }}
        />
        <span className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
          {value}
        </span>
      </div>
      <div className="mt-0.5 text-[0.6875rem] text-[var(--ink-secondary)]">{label}</div>
    </div>
  );
}

/**
 * Age bands for a mixed practice.
 *
 * The first band is "under 18" rather than starting at 18: ABA caseloads are
 * largely paediatric, and bands that start at adulthood silently drop every
 * child from the total.
 */
function ageBands(patients: { date_of_birth: string | null }[]) {
  const bands = [
    { label: "Under 18", min: 0, max: 17, count: 0 },
    { label: "18–30", min: 18, max: 30, count: 0 },
    { label: "31–45", min: 31, max: 45, count: 0 },
    { label: "46–60", min: 46, max: 60, count: 0 },
    { label: "61+", min: 61, max: 200, count: 0 },
  ];
  for (const patient of patients) {
    if (!patient.date_of_birth) continue;
    const age = 2026 - Number(patient.date_of_birth.slice(0, 4));
    const band = bands.find((b) => age >= b.min && age <= b.max);
    if (band) band.count += 1;
  }
  return bands;
}
