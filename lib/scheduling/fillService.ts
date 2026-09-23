/**
 * Fill Service analysis (spec sections 43-44, 51, 54, 67).
 *
 * Answers "how close can this patient get to N hours of a service this week,
 * and what is stopping them?" — generically, with ABA as the first caller.
 *
 * WHAT THIS IS NOT: an optimizer. Choosing the best combination of candidates
 * is a packing problem and belongs to CP-SAT (Phase 2). What this module does
 * instead is bracket the answer honestly:
 *
 *   upper_bound   the most that COULD be scheduled if packing were perfect —
 *                 the overlap between the patient's free time and any eligible
 *                 provider's free time, capped by authorization and clinical
 *                 maximum. A real optimum can never beat this.
 *   achievable    what a greedy longest-first pass actually manages. A real
 *                 optimum is never worse than this.
 *
 * When the two meet, the answer is exact and no solver is needed to know it.
 * When they do not, the gap is reported rather than papered over.
 *
 * The distinction spec section 51 insists on is preserved throughout: unused
 * authorization is NOT available capacity. Hours can be authorized and still
 * unschedulable for want of an available provider.
 */

import {
  SlotRange,
  hoursToSlots,
  intersectAll,
  mergeRanges,
  slotsToHours,
  subtractRanges,
} from "../domain/slots";
import type { CandidateAppointment, UUID } from "../domain/types";
import { ScheduleContext } from "../rules/context";
import { evaluateBooking } from "../rules/engine";
import type { TravelModel } from "../rules/travel";
import { candidateToAppointment, generateCandidates } from "./candidates";

export interface FillServiceRequest {
  patient_id: UUID;
  service_id: UUID;
  /** Defaults to the patient's clinical target, then the authorized hours. */
  target_hours?: number;
  travel?: TravelModel;
  startStepSlots?: number;
}

export type LimitingFactorCode =
  | "AUTHORIZATION_EXHAUSTED"
  | "NO_PROVIDER_OVERLAP"
  | "PATIENT_AVAILABILITY_EXHAUSTED"
  | "BLOCKED_BY_PROTECTED"
  | "BLOCKED_BY_RESTRICTION"
  | "CLINICAL_MAXIMUM_REACHED"
  | "PACKING_GAP";

export interface LimitingFactor {
  code: LimitingFactorCode;
  /** Ordered most-limiting first. */
  message: string;
  hours?: number;
  detail?: Record<string, string | number>;
}

export interface FillServiceAnalysis {
  patient_id: UUID;
  service_id: UUID;
  service_name: string;

  current_hours: number;
  target_hours: number | null;
  authorized_hours: number | null;
  remaining_authorization: number | null;
  clinical_maximum: number | null;

  /** The most that could be added under perfect packing. */
  upper_bound_additional_hours: number;
  /** What a greedy pass actually placed. */
  achievable_additional_hours: number;
  /** current + achievable. */
  projected_hours: number;
  /** True when the bounds agree, so the figure is exact without a solver. */
  exact: boolean;

  /** Concrete appointments the greedy pass would add. Not a recommendation. */
  proposed: CandidateAppointment[];

  /** Why the target is not reachable, most limiting first (section 67). */
  limiting_factors: LimitingFactor[];

  meta: {
    candidates_considered: number;
    candidates_rejected: number;
    truncated: boolean;
    runtime_ms: number;
  };
}

export function analyseFillService(
  ctx: ScheduleContext,
  request: FillServiceRequest,
): FillServiceAnalysis {
  const started = Date.now();

  const service = ctx.services.get(request.service_id);
  if (!service) throw new Error(`Unknown service ${request.service_id}`);

  const requirement = ctx.requirementFor(request.patient_id, request.service_id);
  const authorization = ctx
    .authorizationsFor(request.patient_id, request.service_id)
    .find((a) => a.status === "ACTIVE");

  const currentHours = slotsToHours(
    ctx.slotsScheduled(request.patient_id, request.service_id),
  );

  const targetHours =
    request.target_hours ??
    requirement?.target_hours_per_week ??
    authorization?.authorized_hours ??
    null;

  const authorizedHours = authorization?.authorized_hours ?? null;
  const remainingAuthorization =
    authorizedHours == null ? null : Math.max(0, authorizedHours - currentHours);
  const clinicalMaximum = requirement?.maximum_hours_per_week ?? null;

  // How many more hours are we allowed to want?
  const wantedHours = targetHours == null ? Infinity : Math.max(0, targetHours - currentHours);

  const ceilings = [wantedHours];
  if (remainingAuthorization != null) ceilings.push(remainingAuthorization);
  if (clinicalMaximum != null) ceilings.push(Math.max(0, clinicalMaximum - currentHours));
  const allowedHours = Math.min(...ceilings);

  // -------------------------------------------------------------------------
  // Upper bound: free patient time that at least one eligible provider covers
  // -------------------------------------------------------------------------
  const openWindows = openCoverableWindows(ctx, request.patient_id, request.service_id);
  const minDurationSlots = hoursToSlots(service.min_duration_minutes / 60);
  const usableSlots = openWindows
    .filter((w) => w.endSlot - w.startSlot >= minDurationSlots)
    .reduce((total, w) => total + (w.endSlot - w.startSlot), 0);

  const upperBound = Math.min(slotsToHours(usableSlots), allowedHours);

  // -------------------------------------------------------------------------
  // Greedy placement: a guaranteed-achievable lower bound
  // -------------------------------------------------------------------------
  const generation = generateCandidates(ctx, {
    patient_id: request.patient_id,
    service_ids: [request.service_id],
    target_service_id: request.service_id,
    includeExisting: false,
    travel: request.travel,
    startStepSlots: request.startStepSlots,
  });

  const { placed, hours: achievable } = greedyFill(
    ctx,
    generation.candidates,
    allowedHours,
    request.travel,
  );

  const projected = round(currentHours + achievable);
  const exact = round(achievable) === round(upperBound);

  const limitingFactors = explainShortfall({
    ctx,
    request,
    wantedHours,
    achievable,
    upperBound,
    allowedHours,
    remainingAuthorization,
    clinicalMaximum,
    currentHours,
    openWindows,
  });

  return {
    patient_id: request.patient_id,
    service_id: request.service_id,
    service_name: service.service_name,
    current_hours: round(currentHours),
    target_hours: targetHours,
    authorized_hours: authorizedHours,
    remaining_authorization:
      remainingAuthorization == null ? null : round(remainingAuthorization),
    clinical_maximum: clinicalMaximum,
    upper_bound_additional_hours: round(upperBound),
    achievable_additional_hours: round(achievable),
    projected_hours: projected,
    exact,
    proposed: placed,
    limiting_factors: limitingFactors,
    meta: {
      candidates_considered: generation.candidates.length,
      candidates_rejected: generation.rejected,
      truncated: generation.truncated,
      runtime_ms: Date.now() - started,
    },
  };
}

/**
 * Patient time that is free AND covered by at least one eligible provider who
 * is also free. The union across providers is correct here: the patient only
 * needs one of them at any given moment.
 */
function openCoverableWindows(
  ctx: ScheduleContext,
  patientId: UUID,
  serviceId: UUID,
): SlotRange[] {
  const patientBusy = (ctx.appointmentsByPatient.get(patientId) ?? []).map((a) => a.range);
  const patientFree = subtractRanges(
    ctx.patientAvailableWindows(patientId, serviceId),
    patientBusy,
  );
  if (patientFree.length === 0) return [];

  const providerFree: SlotRange[] = [];
  for (const provider of ctx.eligibleProviders(serviceId)) {
    const busy = (ctx.appointmentsByProvider.get(provider.id) ?? []).map((a) => a.range);
    providerFree.push(
      ...subtractRanges(ctx.providerClinicalWindows(provider.id), busy),
    );
  }
  if (providerFree.length === 0) return [];

  return intersectAll(patientFree, mergeRanges(providerFree));
}

/**
 * Longest-first greedy placement.
 *
 * Deliberately simple and deliberately not called optimal. Longest-first is a
 * good heuristic for hour-maximisation because it minimises the number of
 * fragments, and ties break toward provider continuity, which is an objective
 * in its own right (section 7, level 6).
 */
function greedyFill(
  ctx: ScheduleContext,
  candidates: CandidateAppointment[],
  allowedHours: number,
  travel?: TravelModel,
): { placed: CandidateAppointment[]; hours: number } {
  if (allowedHours <= 0 || candidates.length === 0) return { placed: [], hours: 0 };

  const ordered = [...candidates].sort(
    (a, b) =>
      b.duration_slots - a.duration_slots ||
      (b.objective_values.continuity ?? 0) - (a.objective_values.continuity ?? 0) ||
      (b.objective_values.preferred_provider ?? 0) -
        (a.objective_values.preferred_provider ?? 0) ||
      a.start_slot - b.start_slot,
  );

  const placed: CandidateAppointment[] = [];
  let working = ctx;
  let hours = 0;

  let progress = true;
  while (progress && hours < allowedHours) {
    progress = false;

    for (const candidate of ordered) {
      if (placed.some((p) => p.candidate_id === candidate.candidate_id)) continue;

      const candidateHours = slotsToHours(candidate.duration_slots);
      if (hours + candidateHours > allowedHours + 1e-9) continue;

      const { valid } = evaluateBooking(
        {
          patient_id: candidate.patient_id,
          service_id: candidate.service_id,
          provider_id: candidate.provider_id,
          location_id: candidate.location_id,
          authorization_id: candidate.authorization_id,
          resource_ids: candidate.resource_ids,
          range: { startSlot: candidate.start_slot, endSlot: candidate.end_slot },
          telehealth: false,
        },
        working,
        { travel, includeSoft: false },
      );
      if (!valid) continue;

      placed.push(candidate);
      hours += candidateHours;
      working = working.withExtraAppointments([candidateToAppointment(candidate, working)]);
      progress = true;
      break; // re-sort intent: restart the scan against the updated context
    }
  }

  return { placed, hours };
}

/** Section 67: the facts behind a shortfall, ordered by how much they cost. */
function explainShortfall(input: {
  ctx: ScheduleContext;
  request: FillServiceRequest;
  wantedHours: number;
  achievable: number;
  upperBound: number;
  allowedHours: number;
  remainingAuthorization: number | null;
  clinicalMaximum: number | null;
  currentHours: number;
  openWindows: SlotRange[];
}): LimitingFactor[] {
  const {
    ctx,
    request,
    wantedHours,
    achievable,
    upperBound,
    remainingAuthorization,
    clinicalMaximum,
    currentHours,
    openWindows,
  } = input;

  if (!Number.isFinite(wantedHours) || achievable >= wantedHours - 1e-9) return [];

  const factors: LimitingFactor[] = [];

  if (remainingAuthorization != null && remainingAuthorization < wantedHours) {
    factors.push({
      code: "AUTHORIZATION_EXHAUSTED",
      message:
        remainingAuthorization === 0
          ? "No authorized hours remain this week."
          : `Only ${round(remainingAuthorization)}h of authorization remain.`,
      hours: round(remainingAuthorization),
    });
  }

  if (
    clinicalMaximum != null &&
    clinicalMaximum - currentHours < wantedHours
  ) {
    factors.push({
      code: "CLINICAL_MAXIMUM_REACHED",
      message: `Clinical maximum is ${clinicalMaximum}h per week.`,
      hours: round(Math.max(0, clinicalMaximum - currentHours)),
    });
  }

  const openHours = slotsToHours(
    openWindows.reduce((total, w) => total + (w.endSlot - w.startSlot), 0),
  );
  if (openHours < wantedHours) {
    factors.push({
      code: openWindows.length === 0 ? "NO_PROVIDER_OVERLAP" : "PATIENT_AVAILABILITY_EXHAUSTED",
      message:
        openWindows.length === 0
          ? "No eligible provider is free at any time the patient is available."
          : `Only ${round(openHours)}h where the patient is free and an eligible provider is available.`,
      hours: round(openHours),
    });
  }

  // Time held by appointments that could in principle move.
  const protectedHours = slotsToHours(
    (ctx.appointmentsByPatient.get(request.patient_id) ?? [])
      .filter(
        (a) =>
          a.service_id !== request.service_id &&
          a.scheduling_flexibility !== "FLEXIBLE",
      )
      .reduce((total, a) => total + (a.range.endSlot - a.range.startSlot), 0),
  );
  if (protectedHours > 0) {
    factors.push({
      code: "BLOCKED_BY_PROTECTED",
      message: `${round(protectedHours)}h held by protected or locked appointments for other services.`,
      hours: round(protectedHours),
    });
  }

  const restrictionCount = (ctx.patientRestrictions.get(request.patient_id) ?? []).length;
  if (restrictionCount > 0) {
    const kinds = [
      ...new Set(
        (ctx.patientRestrictions.get(request.patient_id) ?? []).map((r) =>
          r.restriction_type.toLowerCase().replace("_", " "),
        ),
      ),
    ];
    factors.push({
      code: "BLOCKED_BY_RESTRICTION",
      message: `Patient is unavailable during ${kinds.join(", ")}.`,
      detail: { windows: restrictionCount },
    });
  }

  // The bounds disagree: perfect packing beats greedy, so a solver might do better.
  if (upperBound > achievable + 1e-9) {
    factors.push({
      code: "PACKING_GAP",
      message: `A better arrangement may exist: up to ${round(upperBound)}h could fit, greedy placement found ${round(achievable)}h. Resolving this exactly needs the solver.`,
      hours: round(upperBound - achievable),
    });
  }

  // Most limiting first: the smallest headroom is the binding constraint.
  // Factors with no hours attached (a restriction, say) are context rather
  // than the binding number, so they go last rather than leading.
  return factors.sort(
    (a, b) => (a.hours ?? Number.POSITIVE_INFINITY) - (b.hours ?? Number.POSITIVE_INFINITY),
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
