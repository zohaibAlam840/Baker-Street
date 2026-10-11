/**
 * GET /api/scheduling/availability  (spec section 49)
 *
 * Ranked bookable slots for a patient and service. Ranking considers patient
 * preference, provider continuity, location and the shape of the existing
 * schedule; every slot returned carries the breakdown that produced its score.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeApi, isApiError } from "@/lib/auth/api";

import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY } from "@/lib/domain/slots";
import { parseDateOnly, startOfWeek, zonedTimeToInstant } from "@/lib/domain/time";
import { findAvailability } from "@/lib/scheduling/availability";
import { FlatTravelModel } from "@/lib/rules/travel";

export const runtime = "nodejs";

function daysBetween(startDate: string, endDate: string): number {
  const [ys, ms, ds] = startDate.split("-").map(Number);
  const [ye, me, de] = endDate.split("-").map(Number);
  const diff = Date.UTC(ye, me - 1, de) - Date.UTC(ys, ms - 1, ds);
  return Math.floor(diff / 86_400_000) + 1; // inclusive of the end date
}

function parseDateOnlyAsInstant(date: string, timeZone: string): Date {
  const { year, month, day } = parseDateOnly(date);
  return zonedTimeToInstant(timeZone, year, month, day);
}

export async function GET(request: NextRequest) {
  const auth = await authorizeApi("schedule.search_availability");
  if (isApiError(auth)) return auth;
  const params = request.nextUrl.searchParams;

  const patientId = params.get("patient_id");
  const serviceId = params.get("service_id");
  const dateStart = params.get("date_start");
  if (!patientId || !serviceId || !dateStart) {
    return NextResponse.json(
      { error: "`patient_id`, `service_id` and `date_start` are required." },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) {
    return NextResponse.json({ error: "`date_start` must be YYYY-MM-DD." }, { status: 400 });
  }

  const dateEnd = params.get("date_end");
  if (dateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
    return NextResponse.json({ error: "`date_end` must be YYYY-MM-DD." }, { status: 400 });
  }

  const dayCount = dateEnd ? daysBetween(dateStart, dateEnd) : 7;
  if (dayCount < 1 || dayCount > 90) {
    return NextResponse.json(
      { error: "The date range must cover between 1 and 90 days." },
      { status: 400 },
    );
  }

  const timeZone = params.get("timezone") ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  const durationParam = params.get("duration");
  const duration = durationParam ? Number(durationParam) : undefined;
  if (duration != null && (!Number.isFinite(duration) || duration <= 0 || duration % 15 !== 0)) {
    return NextResponse.json(
      { error: "`duration` must be a positive multiple of 15 minutes." },
      { status: 400 },
    );
  }

  const started = Date.now();

  // Load whole weeks, then search only the days the caller asked for. Weekly
  // authorization and frequency totals are derived from the appointments in
  // the horizon, so a horizon that starts mid-week would report hours
  // remaining that the rest of that week has already consumed.
  const horizonStart = startOfWeek(parseDateOnlyAsInstant(dateStart, timeZone), timeZone);
  const leadDays = daysBetween(horizonStart, dateStart) - 1;
  const horizonDays = Math.ceil((leadDays + dayCount) / 7) * 7;

  const { ctx, synthetic } = await loadHorizon({
    startDate: horizonStart,
    dayCount: horizonDays,
    timeZone,
  });

  const slots = findAvailability(
    {
      patient_id: patientId,
      service_id: serviceId,
      duration_minutes: duration,
      provider_id: params.get("provider_id") ?? undefined,
      location_id: params.get("location_id") ?? undefined,
      telehealth: params.get("telehealth") === "true",
      max_results: Number(params.get("limit") ?? 20),
      travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
      window: {
        startSlot: leadDays * SLOTS_PER_DAY,
        endSlot: (leadDays + dayCount) * SLOTS_PER_DAY,
      },
    },
    ctx,
  );

  return NextResponse.json({
    slots,
    meta: {
      synthetic_data: synthetic,
      searched_from: dateStart,
      day_count: dayCount,
      horizon_start: horizonStart,
      horizon_days: horizonDays,
      timezone: timeZone,
      returned: slots.length,
      runtime_ms: Date.now() - started,
    },
  });
}
