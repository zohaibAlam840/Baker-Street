/**
 * POST /api/scheduling/check-conflict  (spec section 48)
 *
 * Answers "can I book this?" with the reasons, and — when the answer is no —
 * with alternatives. Pure rule engine; no solver involved.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeApi, isApiError } from "@/lib/auth/api";

import { startOfWeek } from "@/lib/domain/time";
import { loadHorizon } from "@/lib/data/snapshot";
import { findAvailability } from "@/lib/scheduling/availability";
import { ProposedBooking, evaluateBooking } from "@/lib/rules/engine";
import { FlatTravelModel } from "@/lib/rules/travel";

export const runtime = "nodejs";

interface CheckConflictBody {
  patient_id: string;
  service_id: string;
  provider_id?: string | null;
  location_id?: string | null;
  authorization_id?: string | null;
  resource_ids?: string[];
  start: string; // ISO instant
  end: string; // ISO instant
  telehealth?: boolean;
  /** Set when re-checking an existing appointment, so it ignores itself. */
  appointment_id?: string;
  /** How many alternatives to suggest when invalid. 0 disables the search. */
  max_alternatives?: number;
  timezone?: string;
}

export async function POST(request: NextRequest) {
  const auth = await authorizeApi("schedule.check_conflict");
  if (isApiError(auth)) return auth;
  let body: CheckConflictBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const missing = (["patient_id", "service_id", "start", "end"] as const).filter(
    (field) => !body[field],
  );
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required field(s): ${missing.join(", ")}.` },
      { status: 400 },
    );
  }

  const start = new Date(body.start);
  const end = new Date(body.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return NextResponse.json({ error: "`start` must be a valid instant before `end`." }, { status: 400 });
  }

  const timeZone = body.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  // The horizon must be the whole week containing the request, not the day it
  // falls on: weekly authorization and frequency totals are computed from the
  // appointments inside the horizon, so a Saturday-anchored window would miss
  // Monday to Friday and report hours remaining that do not exist.
  const startDate = startOfWeek(start, timeZone);

  const started = Date.now();
  const { ctx, synthetic } = await loadHorizon({ startDate, dayCount: 7, timeZone });

  const range = ctx.grid.rangeOf(start, end);
  if (!range) {
    return NextResponse.json(
      { error: "The requested window could not be placed on the scheduling grid." },
      { status: 400 },
    );
  }

  const proposal: ProposedBooking = {
    patient_id: body.patient_id,
    service_id: body.service_id,
    provider_id: body.provider_id ?? null,
    location_id: body.location_id ?? null,
    authorization_id: body.authorization_id ?? null,
    resource_ids: body.resource_ids ?? [],
    range,
    telehealth: body.telehealth ?? false,
    appointment_id: body.appointment_id,
  };

  const travel = new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true });
  const result = evaluateBooking(proposal, ctx, { travel, includeSoft: true });

  const wantsAlternatives = (body.max_alternatives ?? 3) > 0;
  const alternatives =
    result.valid || !wantsAlternatives
      ? []
      : findAvailability(
          {
            patient_id: body.patient_id,
            service_id: body.service_id,
            duration_minutes: (range.endSlot - range.startSlot) * 15,
            provider_id: body.provider_id ?? undefined,
            location_id: body.location_id ?? undefined,
            telehealth: body.telehealth,
            authorization_id: body.authorization_id ?? undefined,
            max_results: body.max_alternatives ?? 3,
            travel,
          },
          ctx,
        );

  return NextResponse.json({
    valid: result.valid,
    conflicts: result.violations.filter((v) => v.severity === "HARD"),
    notes: result.violations.filter((v) => v.severity === "SOFT"),
    alternatives,
    meta: {
      synthetic_data: synthetic,
      horizon_start: startDate,
      timezone: timeZone,
      runtime_ms: Date.now() - started,
    },
  });
}
