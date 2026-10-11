/**
 * POST /api/scheduling/fill-service  (spec section 47)
 *
 * Generic by design (section 43): the request names a service, and ABA is
 * simply the first caller. Nothing in this route knows what ABA is.
 *
 * This is non-mutating, single-service capacity ANALYSIS, not the whole-week
 * optimizer. `achievable_additional_hours` comes from a greedy pass and
 * `upper_bound_additional_hours` from patient/provider overlap. When they agree
 * (`exact: true`) the focused answer is exact. When they differ, this endpoint
 * reports the gap; complete plans come from the bounded multi-service optimizer
 * and can be applied only through human approval.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeApi, isApiError } from "@/lib/auth/api";

import { loadHorizon } from "@/lib/data/snapshot";
import { parseDateOnly, startOfWeek, zonedTimeToInstant } from "@/lib/domain/time";
import { analyseFillService } from "@/lib/scheduling/fillService";
import { FlatTravelModel } from "@/lib/rules/travel";

export const runtime = "nodejs";

interface FillServiceBody {
  patient_id: string;
  service_id: string;
  target_hours?: number;
  /** Any date inside the week to analyse. Defaults to the current week. */
  week_start?: string;
  timezone?: string;
  /** 1 = quarter-hour starts (default), 4 = hourly. Higher is faster, coarser. */
  start_step_slots?: number;
}

export async function POST(request: NextRequest) {
  const auth = await authorizeApi("schedule.optimize");
  if (isApiError(auth)) return auth;
  let body: FillServiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.patient_id || !body.service_id) {
    return NextResponse.json(
      { error: "`patient_id` and `service_id` are required." },
      { status: 400 },
    );
  }
  if (body.target_hours != null && (!Number.isFinite(body.target_hours) || body.target_hours < 0)) {
    return NextResponse.json(
      { error: "`target_hours` must be a non-negative number." },
      { status: 400 },
    );
  }
  if (body.week_start && !/^\d{4}-\d{2}-\d{2}$/.test(body.week_start)) {
    return NextResponse.json({ error: "`week_start` must be YYYY-MM-DD." }, { status: 400 });
  }

  const timeZone = body.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";

  // Weekly targets and authorization only add up over a whole week, so the
  // horizon is snapped to the week containing the requested date.
  const anchor = body.week_start
    ? (() => {
        const { year, month, day } = parseDateOnly(body.week_start!);
        return zonedTimeToInstant(timeZone, year, month, day, 12);
      })()
    : new Date();
  const weekStart = startOfWeek(anchor, timeZone);

  const { ctx, synthetic } = await loadHorizon({
    startDate: weekStart,
    dayCount: 7,
    timeZone,
    includeOpaqueBusy: true,
  });

  if (!ctx.patients.has(body.patient_id)) {
    return NextResponse.json({ error: "Unknown patient." }, { status: 404 });
  }
  if (!ctx.services.has(body.service_id)) {
    return NextResponse.json({ error: "Unknown service." }, { status: 404 });
  }

  const analysis = analyseFillService(ctx, {
    patient_id: body.patient_id,
    service_id: body.service_id,
    target_hours: body.target_hours,
    startStepSlots: body.start_step_slots,
    travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
  });

  return NextResponse.json({
    ...analysis,
    // Named to match section 47's response shape.
    additional_hours: analysis.achievable_additional_hours,
    recommended_hours: analysis.projected_hours,
    required_changes: analysis.proposed.length,
    meta: {
      ...analysis.meta,
      synthetic_data: synthetic,
      week_start: weekStart,
      timezone: timeZone,
      /**
       * Honesty flag for this focused endpoint: these figures are greedy
       * bounds, not a whole-week optimization result.
       */
      method: "greedy-with-upper-bound",
      optimal: analysis.exact,
    },
  });
}
