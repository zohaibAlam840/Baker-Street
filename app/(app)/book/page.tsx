import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { evaluateBooking } from "@/lib/rules/engine";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, minutesToSlots } from "@/lib/domain/slots";
import { formatClockTime, parseClockTime } from "@/lib/domain/time";
import { FlatTravelModel } from "@/lib/rules/travel";
import { findAvailability } from "@/lib/scheduling/availability";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Booking: availability search (spec section 49) and conflict check (48).
 *
 * Every slot offered has already been proved against all seventeen hard rules,
 * and carries the breakdown that produced its ranking — so a scheduler can see
 * *why* the top slot is the top slot rather than trusting the order.
 */
export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{
    week?: string;
    patient?: string;
    service?: string;
    duration?: string;
    day?: string;
    time?: string;
    provider?: string;
  }>;
}) {
  await requirePermission("schedule.search_availability");
  const params = await searchParams;

  const { ctx } = await loadHorizon({ startDate: params.week ?? defaultWeekStart() });

  const patients = [...ctx.patients.values()]
    .filter((p) => p.status === "ACTIVE")
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  const patientId = params.patient ?? patients[0]?.id;

  const serviceIds = new Set([
    ...(ctx.patientServiceRequirements.get(patientId ?? "") ?? []).map((r) => r.service_id),
    ...(ctx.authorizations.get(patientId ?? "") ?? []).map((a) => a.service_id),
  ]);
  const services = [...serviceIds]
    .map((id) => ctx.services.get(id))
    .filter((s) => s != null)
    .sort((a, b) => a.service_name.localeCompare(b.service_name));

  const serviceId = params.service ?? services[0]?.id;
  const service = serviceId ? ctx.services.get(serviceId) : undefined;
  const durations = serviceId ? (ctx.serviceDurations.get(serviceId) ?? []) : [];
  const duration = params.duration
    ? Number(params.duration)
    : (service?.default_duration_minutes ?? 60);

  // Conflict check (spec section 48): propose an exact time and hear every
  // reason it is not legal. This is the question a scheduler asks when a
  // family says "can we do Tuesday at four?" — the opposite direction from
  // the availability search below.
  const checkDay = params.day != null ? Number(params.day) : null;
  const checkTime = params.time ?? null;
  let check: ReturnType<typeof evaluateBooking> | null = null;
  let checkRange: { startSlot: number; endSlot: number } | null = null;

  if (patientId && serviceId && checkDay != null && checkTime && !Number.isNaN(checkDay)) {
    const startSlot =
      checkDay * SLOTS_PER_DAY + minutesToSlots(parseClockTime(checkTime));
    checkRange = { startSlot, endSlot: startSlot + minutesToSlots(duration) };

    const provider = params.provider
      ? ctx.providers.get(params.provider)
      : ctx.eligibleProviders(serviceId)[0];

    check = evaluateBooking(
      {
        patient_id: patientId,
        service_id: serviceId,
        provider_id: provider?.id ?? null,
        location_id: provider?.home_location_id ?? null,
        authorization_id:
          ctx.authorizationsFor(patientId, serviceId).find((a) => a.status === "ACTIVE")
            ?.id ?? null,
        resource_ids: [],
        range: checkRange,
        telehealth: false,
      },
      ctx,
      {
        travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
        includeSoft: true,
      },
    );
  }

  const slots =
    patientId && serviceId
      ? findAvailability(
          {
            patient_id: patientId,
            service_id: serviceId,
            duration_minutes: duration,
            max_results: 12,
            travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
          },
          ctx,
        )
      : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Find a time
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-[var(--ink-secondary)]">
          Every slot below is legal: the patient is free, a qualified clinician
          is free, the room is free, and the authorization covers it.
        </p>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4">
        <Field label="Patient">
          <select name="patient" defaultValue={patientId} className={control}>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.first_name} {p.last_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service">
          <select name="service" defaultValue={serviceId} className={control}>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.service_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Length">
          <select name="duration" defaultValue={duration} className={control}>
            {(durations.length > 0 ? durations : [30, 60, 90, 120]).map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </Field>
        <input type="hidden" name="week" value={ctx.grid.startDate} />
        <button
          type="submit"
          className="rounded-full bg-[var(--brand)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Search
        </button>
      </form>

      {/* ------------------------- check a specific time ------------------------- */}
      <Card>
        <CardHeader
          title="Check a specific time"
          sub="“Can we do Tuesday at four?” — every reason it would not be legal"
        />

        <form className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="patient" value={patientId ?? ""} />
          <input type="hidden" name="service" value={serviceId ?? ""} />
          <input type="hidden" name="duration" value={duration} />
          <input type="hidden" name="week" value={ctx.grid.startDate} />

          <Field label="Day">
            <select name="day" defaultValue={checkDay ?? 1} className={control}>
              {Array.from({ length: ctx.grid.dayCount }, (_, day) => (
                <option key={day} value={day}>
                  {WEEKDAYS[ctx.grid.weekdayOf(day)]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Start">
            <input
              type="time"
              name="time"
              step={900}
              defaultValue={checkTime ?? "16:00"}
              className={control}
            />
          </Field>

          <button
            type="submit"
            className="rounded-full border border-[var(--border-ring)] px-5 py-2.5 text-sm font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-sunken)]"
          >
            Check
          </button>
        </form>

        {check && checkRange && (
          <div className="mt-4">
            <p
              className="flex items-center gap-2 text-sm font-medium"
              style={{
                color: check.valid ? "var(--status-good)" : "var(--status-critical)",
              }}
            >
              <span aria-hidden>{check.valid ? "✓" : "✕"}</span>
              {check.valid
                ? "That time is legal — it can be booked."
                : "That time cannot be booked."}
            </p>

            {check.violations.length > 0 && (
              <ul className="mt-3 space-y-2">
                {check.violations.map((violation, index) => (
                  <li
                    key={`${violation.code}-${index}`}
                    className="flex items-start gap-2.5 rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5"
                  >
                    <span
                      aria-hidden
                      className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                      style={{
                        background:
                          violation.severity === "HARD"
                            ? "var(--status-critical)"
                            : "var(--status-warning)",
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-[var(--ink-primary)]">
                        {violation.message}
                      </span>
                      <span className="block text-[0.625rem] text-[var(--ink-muted)]">
                        {violation.severity === "HARD" ? "Blocks the booking" : "Trade-off"}{" "}
                        · {violation.code}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {check.valid && check.violations.length === 0 && (
              <p className="mt-2 text-xs text-[var(--ink-secondary)]">
                No conflicts and no trade-offs.
              </p>
            )}
          </div>
        )}
      </Card>

      <h2 className="pt-2 text-sm font-medium text-[var(--ink-primary)]">
        Or let it find the best times
      </h2>

      {slots.length === 0 ? (
        <Card>
          <CardHeader title="No legal slot this week" />
          <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
            Nothing fits at {duration} minutes. The patient&rsquo;s free time and
            an eligible clinician&rsquo;s free time do not overlap anywhere long
            enough — try a shorter length, or see{" "}
            <Link href="/optimize" className="underline underline-offset-4">
              Fill service
            </Link>{" "}
            for the reasons.
          </p>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {slots.map((slot) => {
            const day = Math.floor(slot.range.startSlot / SLOTS_PER_DAY);
            const startMinutes = (slot.range.startSlot % SLOTS_PER_DAY) * SLOT_MINUTES;
            const endMinutes = startMinutes + slot.duration_minutes;
            const best = slot === slots[0];

            return (
              <li key={`${slot.provider_id}-${slot.start}`}>
                <Card className={best ? "ring-2 ring-[var(--brand-ring)]" : ""}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-[var(--ink-primary)]">
                        {WEEKDAYS[ctx.grid.weekdayOf(day)]} {slot.date.slice(8)}{" "}
                        <span className="tabular-nums">
                          {formatClockTime(startMinutes)}–{formatClockTime(endMinutes)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        {slot.provider_name}
                        {slot.location_id &&
                          ` · ${ctx.locations.get(slot.location_id)?.name ?? ""}`}
                      </div>
                    </div>
                    {best && (
                      <span className="shrink-0 rounded-full bg-[var(--brand-tint)] px-2 py-0.5 text-[0.625rem] font-medium text-[var(--brand)]">
                        Best
                      </span>
                    )}
                  </div>

                  {/* Why it ranks where it ranks. */}
                  <ul className="mt-3 space-y-1">
                    {slot.score_breakdown.map((part) => (
                      <li
                        key={part.label}
                        className="flex items-baseline justify-between gap-2 text-xs"
                      >
                        <span className="text-[var(--ink-secondary)]">{part.label}</span>
                        <span
                          className="tabular-nums"
                          style={{
                            color:
                              part.points >= 0
                                ? "var(--status-good)"
                                : "var(--status-critical)",
                          }}
                        >
                          {part.points > 0 ? "+" : ""}
                          {part.points}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {slot.notes.length > 0 && (
                    <p className="mt-3 text-[0.6875rem] leading-relaxed text-[var(--ink-muted)]">
                      {slot.notes.map((n) => n.message).join(" ")}
                    </p>
                  )}

                  <Link
                    href={`/appointments/new?week=${ctx.grid.startDate}&patient=${patientId}&service=${serviceId}&provider=${slot.provider_id}&location=${slot.location_id ?? ""}&start=${encodeURIComponent(slot.start.slice(0, 16))}&duration=${slot.duration_minutes}`}
                    className="mt-4 block w-full rounded-full border border-[var(--brand)] px-3 py-2 text-center text-xs font-medium text-[var(--brand)]"
                  >
                    Review this appointment
                  </Link>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        Booking is deliberately disabled. Writing an appointment has to go
        through the approval workflow — lock, revalidate, commit, audit — and
        that arrives with real authentication.
      </p>
    </div>
  );
}

const control =
  "h-10 rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 text-sm text-[var(--ink-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-ring)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--ink-secondary)]">{label}</span>
      {children}
    </label>
  );
}
