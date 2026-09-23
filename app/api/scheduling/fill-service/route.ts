/**
 * POST /api/scheduling/fill-service  (spec section 47)
 *
 * Generic by design (section 43): the request names a service, and ABA is
 * simply the first caller. Nothing in this route knows what ABA is.
 *
 * Phase 1 caveat, reported in every response: this is capacity ANALYSIS, not
 * optimization. `achievable_additional_hours` comes from a greedy pass and
 * `upper_bound_additional_hours` from the patient/provider overlap. When they
 * agree (`exact: true`) the answer is provably the best available and no
 * solver is needed. When they differ, the gap is reported and the exact answer
 * waits for CP-SAT.
 */

import { NextRequest, NextResponse } from "next/server";

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
       * Honesty flag. Phase 1 has no solver: these figures bracket the answer
       * rather than optimize it.
       */
      method: "greedy-with-upper-bound",
      optimal: analysis.exact,
    },
  });
}
