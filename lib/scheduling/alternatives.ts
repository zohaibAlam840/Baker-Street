/**
 * Alternative schedules (spec section 56).
 *
 * The spec asks for 3-5 options that differ in ways a human would actually
 * weigh — "30 hours but a provider change" against "29 hours and nothing
 * moves" — and explicitly not five variations that differ by an inconsequential
 * reordering.
 *
 * This legacy helper is intentionally single-service and greedy. Each option
 * is produced by a named strategy and proved legal before it is offered. New
 * whole-week flows use `optimizePatientWeek`, which coordinates all configured
 * service goals with bounded deterministic search.
 */

import { slotsToHours } from "../domain/slots";
import type { CandidateAppointment, UUID } from "../domain/types";
import { ScheduleContext } from "../rules/context";
import { evaluateBooking } from "../rules/engine";
import type { TravelModel } from "../rules/travel";
import { candidateToAppointment, generateCandidates } from "./candidates";

export type StrategyId =
  | "MAX_HOURS"
  | "CONTINUITY"
  | "FEWEST_APPOINTMENTS"
  | "EARLIEST"
  | "PREFERRED_PROVIDER";

export interface Alternative {
  strategy: StrategyId;
  label: string;
  /** What this option is optimising for, in one line. */
  rationale: string;
  appointments: CandidateAppointment[];
  added_hours: number;
  projected_hours: number;
  /** Distinct clinicians introduced who were not already seeing this patient. */
  provider_changes: number;
  /** Whether the patient's preferred clinician is used throughout. */
  keeps_preferred_provider: boolean;
  locations: string[];
}

interface Strategy {
  id: StrategyId;
  label: string;
  rationale: string;
  compare: (a: CandidateAppointment, b: CandidateAppointment) => number;
}

const STRATEGIES: Strategy[] = [
  {
    id: "MAX_HOURS",
    label: "Most hours",
    rationale: "Longest blocks first — fewest fragments, most hours delivered.",
    compare: (a, b) => b.duration_slots - a.duration_slots || a.start_slot - b.start_slot,
  },
  {
    id: "CONTINUITY",
    label: "Same clinician",
    rationale: "Keeps the patient with whoever already sees them, even if it costs hours.",
    compare: (a, b) =>
      (b.objective_values.continuity ?? 0) - (a.objective_values.continuity ?? 0) ||
      b.duration_slots - a.duration_slots,
  },
  {
    id: "PREFERRED_PROVIDER",
    label: "Preferred clinician",
    rationale: "Honours the patient's stated preference before anything else.",
    compare: (a, b) =>
      (b.objective_values.preferred_provider ?? 0) -
        (a.objective_values.preferred_provider ?? 0) ||
      b.duration_slots - a.duration_slots,
  },
  {
    id: "FEWEST_APPOINTMENTS",
    label: "Fewest visits",
    rationale: "Fewest separate appointments — least disruption to the family's week.",
    compare: (a, b) => b.duration_slots - a.duration_slots || b.start_slot - a.start_slot,
  },
  {
    id: "EARLIEST",
    label: "Soonest",
    rationale: "Starts as early in the week as possible.",
    compare: (a, b) => a.start_slot - b.start_slot || b.duration_slots - a.duration_slots,
  },
];

export interface AlternativesRequest {
  patient_id: UUID;
  service_id: UUID;
  target_hours: number;
  travel?: TravelModel;
  max_options?: number;
}

export function buildAlternatives(
  ctx: ScheduleContext,
  request: AlternativesRequest,
): Alternative[] {
  const currentHours = slotsToHours(
    ctx.slotsScheduled(request.patient_id, request.service_id),
  );
  const authorization = ctx
    .authorizationsFor(request.patient_id, request.service_id)
    .find((a) => a.status === "ACTIVE");
  const requirement = ctx.requirementFor(request.patient_id, request.service_id);

  const ceilings = [Math.max(0, request.target_hours - currentHours)];
  if (authorization?.authorized_hours != null) {
    ceilings.push(Math.max(0, authorization.authorized_hours - currentHours));
  }
  if (requirement?.maximum_hours_per_week != null) {
    ceilings.push(Math.max(0, requirement.maximum_hours_per_week - currentHours));
  }
  const allowed = Math.min(...ceilings);
  if (allowed <= 0) return [];

  const { candidates } = generateCandidates(ctx, {
    patient_id: request.patient_id,
    service_ids: [request.service_id],
    target_service_id: request.service_id,
    includeExisting: false,
    travel: request.travel,
  });
  if (candidates.length === 0) return [];

  const incumbents = new Set(
    (ctx.appointmentsByPatient.get(request.patient_id) ?? [])
      .filter((a) => a.service_id === request.service_id && a.provider_id)
      .map((a) => a.provider_id as UUID),
  );

  const out: Alternative[] = [];
  const seen = new Set<string>();

  for (const strategy of STRATEGIES) {
    const placed = packGreedily(ctx, candidates, allowed, strategy, request.travel);
    if (placed.length === 0) continue;

    const addedHours = placed.reduce((t, c) => t + slotsToHours(c.duration_slots), 0);
    const providersUsed = new Set(placed.map((c) => c.provider_id));

    // Deduplicate: two strategies that land on the same appointments are one
    // option, not two. This is the rule that keeps section 56 honest.
    const signature = placed
      .map((c) =>
        [
          c.service_id,
          c.provider_id,
          c.authorization_id ?? "no-auth",
          c.location_id ?? "no-location",
          [...c.resource_ids].sort().join(",") || "no-resource",
          c.start_slot,
          c.duration_slots,
        ].join(":"),
      )
      .sort()
      .join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);

    out.push({
      strategy: strategy.id,
      label: strategy.label,
      rationale: strategy.rationale,
      appointments: placed,
      added_hours: Math.round(addedHours * 100) / 100,
      projected_hours: Math.round((currentHours + addedHours) * 100) / 100,
      provider_changes: [...providersUsed].filter((id) => !incumbents.has(id)).length,
      keeps_preferred_provider: placed.every(
        (c) => (c.objective_values.preferred_provider ?? 0) === 1,
      ),
      locations: [
        ...new Set(
          placed.map((c) =>
            c.location_id ? (ctx.locations.get(c.location_id)?.name ?? "—") : "—",
          ),
        ),
      ],
    });
  }

  // Best hours first, then fewest disruptions — the order a scheduler reads in.
  out.sort(
    (a, b) =>
      b.added_hours - a.added_hours ||
      a.provider_changes - b.provider_changes ||
      a.appointments.length - b.appointments.length,
  );

  return out.slice(0, request.max_options ?? 4);
}

/** Place candidates under one strategy's ordering, proving each as it goes. */
function packGreedily(
  ctx: ScheduleContext,
  candidates: CandidateAppointment[],
  allowedHours: number,
  strategy: Strategy,
  travel?: TravelModel,
): CandidateAppointment[] {
  const ordered = [...candidates].sort(strategy.compare);
  const placed: CandidateAppointment[] = [];
  let working = ctx;
  let hours = 0;
  let progress = true;

  while (progress && hours < allowedHours - 0.001) {
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
      working = working.withExtraAppointments(
        [candidateToAppointment(candidate, working)],
        candidate.resource_ids.map((resource_id) => ({
          appointment_id: candidate.candidate_id,
          resource_id,
        })),
      );
      progress = true;
      break;
    }
  }

  return placed;
}
