/**
 * Deterministic multi-service patient-week optimizer.
 *
 * The candidate generator and rule engine do the safety-critical work: every
 * candidate is legal against the loaded schedule. This module chooses a set of
 * non-overlapping candidates across *all* of a patient's services, under each
 * service's clinical and payer ceilings. A bounded beam keeps runtime suitable
 * for a serverless request while several objective orders produce genuinely
 * different plans for a human to compare.
 *
 * This is intentionally honest about its proof status. Reaching every target
 * proves the primary objective cannot be improved; otherwise the result is
 * FEASIBLE rather than claiming the global optimality that a CP-SAT service
 * would provide.
 */

import { createHash } from "node:crypto";

import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "../domain/slots";
import type {
  AppointmentStatus,
  CandidateAppointment,
  SchedulingFlexibility,
  UUID,
} from "../domain/types";
import { ScheduleContext } from "../rules/context";
import { evaluateBooking } from "../rules/engine";
import type { TravelModel } from "../rules/travel";
import { candidateToAppointment, generateCandidates } from "./candidates";

export type OptimizerStatus = "TARGETS_MET" | "FEASIBLE" | "INFEASIBLE" | "BOUNDED";
export type PlanStrategy = "BALANCED" | "CONTINUITY" | "FEWEST_VISITS" | "PREFERRED" | "EARLIEST";
export type OptimizerEngine = "TYPESCRIPT_BOUNDED" | "PYTHON_CP_SAT";
export type SolverStatus = "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN";

export interface ServiceGoal {
  service_id: UUID;
  service_name: string;
  required: boolean;
  priority: number;
  current_hours: number;
  minimum_hours: number | null;
  target_hours: number;
  maximum_hours: number | null;
  authorized_hours: number | null;
  current_sessions: number;
  minimum_sessions: number | null;
  target_sessions: number | null;
  maximum_sessions: number | null;
  addable_sessions: number;
  /** Slots the optimizer may add without exceeding any clinical/payer ceiling. */
  addable_slots: number;
}

export interface PlanServiceMetric {
  service_id: UUID;
  service_name: string;
  required: boolean;
  current_hours: number;
  added_hours: number;
  projected_hours: number;
  target_hours: number;
  target_met: boolean;
  minimum_met: boolean;
  current_sessions: number;
  added_sessions: number;
  projected_sessions: number;
  target_sessions: number | null;
}

export interface OptimizedPlan {
  id: string;
  strategy: PlanStrategy;
  label: string;
  rationale: string;
  /** New visits created by this option. */
  appointments: CandidateAppointment[];
  /** Existing flexible visits relocated before the new visits are added. */
  moves: OptimizedMove[];
  service_metrics: PlanServiceMetric[];
  added_hours: number;
  targets_met: number;
  required_services_met: boolean;
  provider_changes: number;
  preferred_appointments: number;
  /** False plans are useful diagnostics but can never be submitted. */
  approvable: boolean;
}

export interface OptimizedMove {
  appointment_id: UUID;
  service_id: UUID;
  status: AppointmentStatus;
  flexibility: SchedulingFlexibility;
  authorization_id: UUID | null;
  telehealth: boolean;
  old_start_slot: number;
  old_end_slot: number;
  old_provider_id: UUID;
  old_location_id: UUID | null;
  old_resource_ids: UUID[];
  replacement: CandidateAppointment;
}

export interface OptimizationExplanation {
  service_id?: UUID;
  code: string;
  message: string;
}

export interface PatientWeekOptimization {
  patient_id: UUID;
  week_start: string;
  status: OptimizerStatus;
  goals: ServiceGoal[];
  plans: OptimizedPlan[];
  explanations: OptimizationExplanation[];
  meta: {
    engine: OptimizerEngine;
    solver_status: SolverStatus | null;
    optimality_proven: boolean;
    fallback_reason: string | null;
    generated_candidates: number;
    searched_candidates: number;
    rejected_candidates: number;
    candidate_generation_truncated: boolean;
    search_reduced: boolean;
    search_limit_reached: boolean;
    move_sources_considered: number;
    move_destinations_considered: number;
    runtime_ms: number;
  };
}

export interface OptimizePatientWeekRequest {
  patient_id: UUID;
  service_ids?: UUID[];
  /** Optional per-service clinical target overrides, expressed in hours. */
  target_hours?: Record<UUID, number>;
  max_solutions?: number;
  max_search_candidates?: number;
  beam_width?: number;
  start_step_slots?: number;
  /** Deterministic safety bound across candidate/state expansions per strategy. */
  max_search_operations?: number;
  /** Explore bounded one-visit rearrangements when additions alone fall short. */
  allow_moves?: boolean;
  /** Deterministic safety bounds for move rescue exploration. */
  max_move_sources?: number;
  max_move_destinations?: number;
  /** Do not suggest moving a visit that has started by this instant. */
  move_not_before?: Date;
  travel?: TravelModel;
}

interface SearchState {
  selected: CandidateAppointment[];
  added: number[];
  sessions: number[];
  lastEnd: number;
  continuity: number;
  preferred: number;
  startSum: number;
  authorization: Record<string, number>;
}

interface StrategyDefinition {
  id: PlanStrategy;
  label: string;
  rationale: string;
}

const STRATEGIES: StrategyDefinition[] = [
  {
    id: "BALANCED",
    label: "Best clinical coverage",
    rationale: "Completes required services first, then closes the largest target gaps.",
  },
  {
    id: "CONTINUITY",
    label: "Strongest continuity",
    rationale: "Keeps existing clinicians where coverage is otherwise comparable.",
  },
  {
    id: "FEWEST_VISITS",
    label: "Fewest visits",
    rationale: "Uses longer sessions to reduce disruption for the patient and family.",
  },
  {
    id: "PREFERRED",
    label: "Patient preferences",
    rationale: "Favors preferred clinicians after required care is protected.",
  },
  {
    id: "EARLIEST",
    label: "Earliest completion",
    rationale: "Places the same clinical coverage as early in the week as possible.",
  },
];

const DEFAULT_MAX_SEARCH_CANDIDATES = 2_400;
const DEFAULT_BEAM_WIDTH = 220;
const DEFAULT_MAX_SEARCH_OPERATIONS = 500_000;

export function optimizePatientWeek(
  ctx: ScheduleContext,
  request: OptimizePatientWeekRequest,
): PatientWeekOptimization {
  const started = Date.now();
  const additionsOnly = optimizeAdditions(ctx, request);
  if (
    request.allow_moves === false ||
    additionsOnly.status === "TARGETS_MET" ||
    additionsOnly.goals.every((goal) => goal.addable_slots <= 0)
  ) {
    return additionsOnly;
  }

  const rescued = exploreMoveRescues(ctx, request, additionsOnly);
  return {
    ...rescued,
    meta: {
      ...rescued.meta,
      runtime_ms: Date.now() - started,
    },
  };
}

function optimizeAdditions(
  ctx: ScheduleContext,
  request: OptimizePatientWeekRequest,
): PatientWeekOptimization {
  const started = Date.now();
  if (!ctx.patients.has(request.patient_id)) {
    throw new Error(`Unknown patient ${request.patient_id}`);
  }

  const goals = buildGoals(ctx, request);
  const searchable = goals.filter((goal) => goal.addable_slots > 0);
  if (searchable.length === 0) {
    const allMet = goals.length > 0 && goals.every(goalAlreadyMet);
    return {
      patient_id: request.patient_id,
      week_start: ctx.grid.startDate,
      status: allMet ? "TARGETS_MET" : "INFEASIBLE",
      goals,
      plans: [],
      explanations: explainNoCandidates(goals),
      meta: {
        engine: "TYPESCRIPT_BOUNDED",
        solver_status: null,
        optimality_proven: false,
        fallback_reason: null,
        generated_candidates: 0,
        searched_candidates: 0,
        rejected_candidates: 0,
        candidate_generation_truncated: false,
        search_reduced: false,
        search_limit_reached: false,
        move_sources_considered: 0,
        move_destinations_considered: 0,
        runtime_ms: Date.now() - started,
      },
    };
  }

  const generation = generateCandidates(ctx, {
    patient_id: request.patient_id,
    service_ids: searchable.map((goal) => goal.service_id),
    includeExisting: false,
    startStepSlots: request.start_step_slots ?? 2,
    maxCandidates: 12_000,
    travel: request.travel,
  });

  const reduced = reduceOptimizerCandidates(
    generation.candidates,
    request.max_search_candidates ?? DEFAULT_MAX_SEARCH_CANDIDATES,
  );
  const goalIndex = new Map(goals.map((goal, index) => [goal.service_id, index]));
  const authorizationLimits = optimizerAuthorizationBudgets(ctx, request.patient_id);
  const candidates = reduced.candidates
    .filter((candidate) => {
      const index = goalIndex.get(candidate.service_id);
      return index != null && candidate.duration_slots <= goals[index].addable_slots;
    })
    .sort(candidateOrder);

  const rawStates: { strategy: StrategyDefinition; state: SearchState }[] = [];
  let timeLimitReached = false;
  for (const strategy of STRATEGIES) {
    const searched = search(
      candidates,
      goals,
      goalIndex,
      authorizationLimits,
      strategy.id,
      request.beam_width ?? DEFAULT_BEAM_WIDTH,
      request.max_search_operations ?? DEFAULT_MAX_SEARCH_OPERATIONS,
    );
    timeLimitReached ||= searched.timedOut;
    const best = searched.states.find((state) => {
      const legal = reprovePlan(ctx, state.selected, request.travel);
      return legal != null && legal.length > 0;
    });
    if (best) rawStates.push({ strategy, state: best });
  }

  const incumbentProviders = new Set(
    (ctx.appointmentsByPatient.get(request.patient_id) ?? [])
      .filter((appointment) => appointment.provider_id)
      .map((appointment) => appointment.provider_id as UUID),
  );
  const plans: OptimizedPlan[] = [];
  const seen = new Set<string>();

  for (const { strategy, state } of rawStates) {
    const legal = reprovePlan(ctx, state.selected, request.travel);
    if (!legal || legal.length === 0) continue;
    const signature = legal.map((candidate) => candidate.candidate_id).sort().join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);

    const serviceMetrics = metricsFor(goals, legal);
    const fingerprint = planFingerprint(ctx, goals, legal, serviceMetrics);
    const requiredMet = serviceMetrics
      .filter((metric) => metric.required)
      .every((metric) => metric.minimum_met);
    const providers = new Set(legal.map((candidate) => candidate.provider_id));
    plans.push({
      id: `plan_${stableHash(fingerprint)}`,
      strategy: strategy.id,
      label: strategy.label,
      rationale: strategy.rationale,
      appointments: legal,
      moves: [],
      service_metrics: serviceMetrics,
      added_hours: round(
        legal.reduce((total, candidate) => total + slotsToHours(candidate.duration_slots), 0),
      ),
      targets_met: serviceMetrics.filter((metric) => metric.target_met).length,
      required_services_met: requiredMet,
      provider_changes: [...providers].filter((provider) => !incumbentProviders.has(provider)).length,
      preferred_appointments: legal.filter(
        (candidate) => (candidate.objective_values.preferred_provider ?? 0) > 0,
      ).length,
      approvable: requiredMet,
    });
    if (plans.length >= (request.max_solutions ?? 4)) break;
  }

  plans.sort(compareOptimizedPlans);
  const best = plans.find((plan) => plan.approvable);
  const targetsMet = best ? best.service_metrics.every((metric) => metric.target_met) : false;
  const explanations = explainOptimizerShortfalls(goals, best, generation.rejectionsByCode);
  const bounded = generation.truncated || reduced.reduced || timeLimitReached;

  return {
    patient_id: request.patient_id,
    week_start: ctx.grid.startDate,
    status: targetsMet ? "TARGETS_MET" : bounded ? "BOUNDED" : !best ? "INFEASIBLE" : "FEASIBLE",
    goals,
    plans,
    explanations,
    meta: {
      engine: "TYPESCRIPT_BOUNDED",
      solver_status: null,
      optimality_proven: false,
      fallback_reason: null,
      generated_candidates: generation.candidates.length,
      searched_candidates: candidates.length,
      rejected_candidates: generation.rejected,
      candidate_generation_truncated: generation.truncated,
      search_reduced: reduced.reduced,
      search_limit_reached: timeLimitReached,
      move_sources_considered: 0,
      move_destinations_considered: 0,
      runtime_ms: Date.now() - started,
    },
  };
}

/**
 * Additions remain the default because they are least disruptive. When they
 * cannot reach the configured targets, explore a deliberately small set of
 * plans that relocate exactly one FLEXIBLE visit and then rerun the complete
 * addition search against that hypothetical schedule. A one-move boundary
 * keeps approval understandable and avoids hidden chains of patient changes.
 */
function exploreMoveRescues(
  ctx: ScheduleContext,
  request: OptimizePatientWeekRequest,
  additionsOnly: PatientWeekOptimization,
): PatientWeekOptimization {
  const sourceLimit = Math.max(0, request.max_move_sources ?? 3);
  const destinationLimit = Math.max(0, request.max_move_destinations ?? 2);
  if (sourceLimit === 0 || destinationLimit === 0) return additionsOnly;

  const movable = (ctx.appointmentsByPatient.get(request.patient_id) ?? [])
    .filter(
      (appointment) =>
        appointment.scheduling_flexibility === "FLEXIBLE" &&
        (appointment.status === "SCHEDULED" || appointment.status === "CONFIRMED") &&
        appointment.provider_id != null &&
        !appointment.telehealth &&
        (!request.move_not_before ||
          new Date(appointment.start_time).getTime() > request.move_not_before.getTime()),
    )
    .sort(
      (a, b) =>
        b.range.endSlot - b.range.startSlot - (a.range.endSlot - a.range.startSlot) ||
        a.range.startSlot - b.range.startSlot ||
        a.id.localeCompare(b.id),
    );
  const sources = movable.slice(0, sourceLimit);
  const movePlans: OptimizedPlan[] = [];
  let moveDestinationsConsidered = 0;
  let generatedCandidates = additionsOnly.meta.generated_candidates;
  let searchedCandidates = additionsOnly.meta.searched_candidates;
  let rejectedCandidates = additionsOnly.meta.rejected_candidates;
  let generationTruncated = additionsOnly.meta.candidate_generation_truncated;
  let searchReduced = additionsOnly.meta.search_reduced;
  let searchLimitReached = additionsOnly.meta.search_limit_reached;
  const baseline = additionsOnly.plans[0];

  for (const source of sources) {
    const sourceProviderId = source.provider_id;
    if (!sourceProviderId) continue;
    const withoutSource = ctx.withoutAppointments(new Set([source.id]));
    const generation = generateCandidates(withoutSource, {
      patient_id: request.patient_id,
      service_ids: [source.service_id],
      durations: [(source.range.endSlot - source.range.startSlot) * SLOT_MINUTES],
      includeExisting: false,
      startStepSlots: request.start_step_slots ?? 2,
      maxCandidates: 6_000,
      minimumStartSlot: moveMinimumStartSlot(ctx, request.move_not_before),
      travel: request.travel,
    });
    generatedCandidates += generation.candidates.length;
    rejectedCandidates += generation.rejected;
    generationTruncated ||= generation.truncated;

    const legalDestinations = generation.candidates.filter(
      (candidate) =>
        candidate.authorization_id === source.authorization_id &&
        !samePlacement(source, candidate),
    );
    const destinations = pickMoveDestinations(source, legalDestinations, destinationLimit);
    moveDestinationsConsidered += destinations.length;
    searchReduced ||= legalDestinations.length > destinations.length;

    for (const replacement of destinations) {
      const movedAppointment = {
        ...candidateToAppointment(replacement, withoutSource),
        id: source.id,
        status: source.status,
        scheduling_flexibility: source.scheduling_flexibility,
        original_start_time: source.original_start_time,
        original_provider_id: source.original_provider_id,
        original_location_id: source.original_location_id,
      };
      const moved = withoutSource.withExtraAppointments(
        [movedAppointment],
        replacement.resource_ids.map((resource_id) => ({
          appointment_id: source.id,
          resource_id,
        })),
      );
      const rescue = optimizeAdditions(moved, {
        ...request,
        allow_moves: false,
        max_solutions: 1,
        max_search_candidates: Math.min(request.max_search_candidates ?? 1_200, 1_200),
        beam_width: Math.min(request.beam_width ?? 120, 120),
        max_search_operations: Math.min(
          request.max_search_operations ?? 150_000,
          150_000,
        ),
      });
      generatedCandidates += rescue.meta.generated_candidates;
      searchedCandidates += rescue.meta.searched_candidates;
      rejectedCandidates += rescue.meta.rejected_candidates;
      generationTruncated ||= rescue.meta.candidate_generation_truncated;
      searchReduced ||= rescue.meta.search_reduced;
      searchLimitReached ||= rescue.meta.search_limit_reached;
      const rescuedPlan = rescue.plans[0];
      if (!rescuedPlan || !rescuedPlan.approvable) continue;
      if (baseline && compareClinicalCoverage(rescuedPlan, baseline) <= 0) continue;

      const move: OptimizedMove = {
        appointment_id: source.id,
        service_id: source.service_id,
        status: source.status,
        flexibility: source.scheduling_flexibility,
        authorization_id: source.authorization_id,
        telehealth: source.telehealth,
        old_start_slot: source.range.startSlot,
        old_end_slot: source.range.endSlot,
        old_provider_id: sourceProviderId,
        old_location_id: source.location_id,
        old_resource_ids: [...source.resource_ids].sort(),
        replacement,
      };
      movePlans.push({
        ...rescuedPlan,
        id: `plan_${stableHash(JSON.stringify({ base: rescuedPlan.id, move }))}`,
        label: `${rescuedPlan.label} with one move`,
        rationale: `${rescuedPlan.rationale} Relocates one flexible visit because additions alone leave more care uncovered.`,
        moves: [move],
        provider_changes:
          rescuedPlan.provider_changes + Number(sourceProviderId !== replacement.provider_id),
        preferred_appointments:
          rescuedPlan.preferred_appointments +
          Number((replacement.objective_values.preferred_provider ?? 0) > 0),
      });
    }
  }

  const plans = deduplicatePlans([...additionsOnly.plans, ...movePlans])
    .sort(compareOptimizedPlans)
    .slice(0, request.max_solutions ?? 4);
  const best = plans.find((plan) => plan.approvable);
  const targetsMet = Boolean(best?.service_metrics.every((metric) => metric.target_met));
  const explorationBounded =
    movable.length > sources.length ||
    searchReduced ||
    generationTruncated ||
    searchLimitReached;

  return {
    ...additionsOnly,
    status: targetsMet
      ? "TARGETS_MET"
      : explorationBounded
        ? "BOUNDED"
        : best
          ? "FEASIBLE"
          : "INFEASIBLE",
    plans,
    explanations: explainOptimizerShortfalls(additionsOnly.goals, best, {}),
    meta: {
      engine: additionsOnly.meta.engine,
      solver_status: additionsOnly.meta.solver_status,
      optimality_proven: additionsOnly.meta.optimality_proven,
      fallback_reason: additionsOnly.meta.fallback_reason,
      generated_candidates: generatedCandidates,
      searched_candidates: searchedCandidates,
      rejected_candidates: rejectedCandidates,
      candidate_generation_truncated: generationTruncated,
      search_reduced: searchReduced,
      search_limit_reached: searchLimitReached,
      move_sources_considered: sources.length,
      move_destinations_considered: moveDestinationsConsidered,
      runtime_ms: additionsOnly.meta.runtime_ms,
    },
  };
}

function moveMinimumStartSlot(ctx: ScheduleContext, notBefore: Date | undefined): number {
  if (!notBefore) return 0;
  const slot = ctx.grid.slotOf(notBefore);
  if (slot != null) return Math.min(ctx.grid.totalSlots, slot + 1);
  return notBefore < ctx.grid.dayStart(0) ? 0 : ctx.grid.totalSlots;
}

function samePlacement(
  source: ScheduleContext["appointments"][number],
  candidate: CandidateAppointment,
): boolean {
  return (
    source.range.startSlot === candidate.start_slot &&
    source.range.endSlot === candidate.end_slot &&
    source.provider_id === candidate.provider_id &&
    source.location_id === candidate.location_id &&
    [...source.resource_ids].sort().join(",") === [...candidate.resource_ids].sort().join(",")
  );
}

function pickMoveDestinations(
  source: ScheduleContext["appointments"][number],
  candidates: CandidateAppointment[],
  limit: number,
): CandidateAppointment[] {
  const ordered = [...candidates].sort((a, b) => {
    const aCost = moveDisruptionCost(source, a);
    const bCost = moveDisruptionCost(source, b);
    return aCost - bCost || candidateOrder(a, b);
  });
  if (ordered.length <= limit) return ordered;

  const selected = [ordered[0]];
  const sourceDay = Math.floor(source.range.startSlot / SLOTS_PER_DAY);
  const differentDay = ordered.find(
    (candidate) => Math.floor(candidate.start_slot / SLOTS_PER_DAY) !== sourceDay,
  );
  if (differentDay && selected.length < limit) selected.push(differentDay);
  for (const candidate of ordered) {
    if (selected.length >= limit) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

function moveDisruptionCost(
  source: ScheduleContext["appointments"][number],
  candidate: CandidateAppointment,
): number {
  return (
    Math.abs(candidate.start_slot - source.range.startSlot) +
    Number(candidate.provider_id !== source.provider_id) * 10_000 +
    Number(candidate.location_id !== source.location_id) * 5_000 +
    Number(
      [...candidate.resource_ids].sort().join(",") !== [...source.resource_ids].sort().join(","),
    ) * 1_000
  );
}

function compareClinicalCoverage(a: OptimizedPlan, b: OptimizedPlan): number {
  const requiredMinimums = (plan: OptimizedPlan) =>
    plan.service_metrics.filter((metric) => metric.required && metric.minimum_met).length;
  const targetCoverage = (plan: OptimizedPlan) =>
    plan.service_metrics.reduce(
      (total, metric) => total + Math.min(metric.projected_hours, metric.target_hours),
      0,
    );
  return (
    Number(a.required_services_met) - Number(b.required_services_met) ||
    requiredMinimums(a) - requiredMinimums(b) ||
    a.targets_met - b.targets_met ||
    targetCoverage(a) - targetCoverage(b) ||
    a.added_hours - b.added_hours
  );
}

function deduplicatePlans(plans: OptimizedPlan[]): OptimizedPlan[] {
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const signature = JSON.stringify({
      appointments: plan.appointments.map((candidate) => candidate.candidate_id).sort(),
      moves: plan.moves.map((move) => ({
        appointment_id: move.appointment_id,
        replacement: move.replacement.candidate_id,
      })),
    });
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function buildGoals(ctx: ScheduleContext, request: OptimizePatientWeekRequest): ServiceGoal[] {
  const requested = request.service_ids ? new Set(request.service_ids) : null;
  const ids = new Set<UUID>();
  for (const row of ctx.patientServiceRequirements.get(request.patient_id) ?? []) {
    if (!requested || requested.has(row.service_id)) ids.add(row.service_id);
  }
  for (const row of ctx.authorizations.get(request.patient_id) ?? []) {
    if (row.status === "ACTIVE" && (!requested || requested.has(row.service_id))) ids.add(row.service_id);
  }
  if (requested) for (const id of requested) ids.add(id);

  return [...ids]
    .map((serviceId): ServiceGoal | null => {
      const service = ctx.services.get(serviceId);
      if (!service?.active) return null;
      const requirement = ctx.requirementFor(request.patient_id, serviceId);
      const authorization = ctx
        .authorizationsFor(request.patient_id, serviceId)
        .find((row) => row.status === "ACTIVE");
      const currentSlots = ctx.slotsScheduled(request.patient_id, serviceId);
      const currentHours = slotsToHours(currentSlots);
      const appointments = (ctx.appointmentsByPatient.get(request.patient_id) ?? []).filter(
        (appointment) => appointment.service_id === serviceId,
      );
      const override = request.target_hours?.[serviceId];
      const explicitTarget =
        override ?? requirement?.target_hours_per_week ?? requirement?.minimum_hours_per_week;
      const wantedSessions =
        requirement?.target_sessions_per_week ?? requirement?.minimum_sessions_per_week ?? appointments.length;
      const sessionDeficit = Math.max(0, wantedSessions - appointments.length);
      const durationForFrequency = service.default_duration_minutes / 60;
      const target = Math.max(
        0,
        explicitTarget ?? currentHours + sessionDeficit * durationForFrequency,
      );
      const hourCeilings = [target];
      if (requirement?.maximum_hours_per_week != null) {
        hourCeilings.push(requirement.maximum_hours_per_week);
      }
      const authorizedHours = authorization ? authorizationHours(authorization) : null;
      if (service.requires_authorization) {
        hourCeilings.push(authorizedHours ?? currentHours);
      } else if (authorizedHours != null) {
        hourCeilings.push(authorizedHours);
      }
      const sessionCeiling = requirement?.maximum_sessions_per_week;
      const sessionRoom =
        sessionCeiling == null ? Number.POSITIVE_INFINITY : Math.max(0, sessionCeiling - appointments.length);
      const hoursRoom = Math.max(0, Math.min(...hourCeilings) - currentHours);
      const maximumDuration = Math.max(...(ctx.serviceDurations.get(serviceId) ?? [service.default_duration_minutes]));
      const sessionSlotsRoom = Number.isFinite(sessionRoom)
        ? sessionRoom * Math.max(1, Math.round(maximumDuration / SLOT_MINUTES))
        : Number.POSITIVE_INFINITY;

      return {
        service_id: serviceId,
        service_name: service.service_name,
        required: requirement?.required ?? false,
        priority: requirement?.priority ?? 100,
        current_hours: round(currentHours),
        minimum_hours: requirement?.minimum_hours_per_week ?? null,
        target_hours: round(target),
        maximum_hours: requirement?.maximum_hours_per_week ?? null,
        authorized_hours: authorizedHours,
        current_sessions: appointments.length,
        minimum_sessions: requirement?.minimum_sessions_per_week ?? null,
        target_sessions: requirement?.target_sessions_per_week ?? null,
        maximum_sessions: requirement?.maximum_sessions_per_week ?? null,
        addable_sessions: sessionRoom,
        addable_slots: Math.max(0, Math.floor(Math.min(hoursRoom * 60 / SLOT_MINUTES, sessionSlotsRoom))),
      };
    })
    .filter((goal): goal is ServiceGoal => goal != null)
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        a.priority - b.priority ||
        a.service_name.localeCompare(b.service_name) ||
        a.service_id.localeCompare(b.service_id),
    );
}

export function reduceOptimizerCandidates(
  candidates: CandidateAppointment[],
  maximum: number,
): { candidates: CandidateAppointment[]; reduced: boolean } {
  // Providers are interchangeable for the patient's collision constraint at
  // a given service/time/duration. Keep the best continuity/preference choices
  // and enough alternatives for meaningful plans instead of feeding thousands
  // of duplicate intervals into the bounded search.
  const groups = new Map<string, CandidateAppointment[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.service_id,
      candidate.start_slot,
      candidate.duration_slots,
      candidate.authorization_id ?? "no-auth",
      candidate.location_id ?? "no-location",
      [...candidate.resource_ids].sort().join(",") || "no-resource",
    ].join(":");
    const bucket = groups.get(key);
    if (bucket) bucket.push(candidate);
    else groups.set(key, [candidate]);
  }
  const out: CandidateAppointment[] = [];
  for (const key of [...groups.keys()].sort()) {
    const bucket = groups.get(key)!;
    bucket.sort(
      (a, b) =>
        (b.objective_values.preferred_provider ?? 0) - (a.objective_values.preferred_provider ?? 0) ||
        (b.objective_values.continuity ?? 0) - (a.objective_values.continuity ?? 0) ||
        a.provider_id.localeCompare(b.provider_id) ||
        a.candidate_id.localeCompare(b.candidate_id),
    );
    out.push(...bucket.slice(0, 3));
  }
  out.sort(candidateOrder);
  if (out.length <= maximum) return { candidates: out, reduced: false };

  // Round-robin service/day buckets prevent a large ABA pool from erasing a
  // smaller required service or the end of the week when the safety cap hits.
  const buckets = new Map<string, CandidateAppointment[]>();
  for (const candidate of out) {
    const day = Math.floor(candidate.start_slot / 96);
    const key = `${candidate.service_id}:${day}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }
  const selected: CandidateAppointment[] = [];
  const lists = [...buckets.keys()].sort().map((key) => buckets.get(key)!);
  for (let index = 0; selected.length < maximum; index += 1) {
    let progressed = false;
    for (const list of lists) {
      const candidate = list[index];
      if (!candidate) continue;
      selected.push(candidate);
      progressed = true;
      if (selected.length === maximum) break;
    }
    if (!progressed) break;
  }
  return { candidates: selected.sort(candidateOrder), reduced: true };
}

function search(
  candidates: CandidateAppointment[],
  goals: ServiceGoal[],
  goalIndex: Map<UUID, number>,
  authorizationLimits: Map<UUID, number>,
  strategy: PlanStrategy,
  beamWidth: number,
  maxOperations: number,
): { states: SearchState[]; timedOut: boolean } {
  let beam: SearchState[] = [{
    selected: [],
    added: goals.map(() => 0),
    sessions: goals.map(() => 0),
    lastEnd: -1,
    continuity: 0,
    preferred: 0,
    startSum: 0,
    authorization: {},
  }];

  let operations = 0;
  for (const candidate of candidates) {
    if (operations + beam.length > maxOperations) {
      return {
        states: beam.sort((a, b) => compareStates(b, a, goals, strategy)),
        timedOut: true,
      };
    }
    operations += beam.length;
    const index = goalIndex.get(candidate.service_id);
    if (index == null) continue;
    const expanded = [...beam];
    for (const state of beam) {
      if (candidate.start_slot < state.lastEnd) continue;
      if (state.added[index] + candidate.duration_slots > goals[index].addable_slots) continue;
      const maxSessions = sessionLimit(goals[index]);
      if (state.sessions[index] + 1 > maxSessions) continue;
      if (candidate.authorization_id) {
        const used = state.authorization[candidate.authorization_id] ?? 0;
        const limit = authorizationLimits.get(candidate.authorization_id) ?? 0;
        if (used + candidate.duration_slots > limit) continue;
      }
      const added = [...state.added];
      const sessions = [...state.sessions];
      const authorization = { ...state.authorization };
      added[index] += candidate.duration_slots;
      sessions[index] += 1;
      if (candidate.authorization_id) {
        authorization[candidate.authorization_id] =
          (authorization[candidate.authorization_id] ?? 0) + candidate.duration_slots;
      }
      expanded.push({
        selected: [...state.selected, candidate],
        added,
        sessions,
        lastEnd: candidate.end_slot,
        continuity: state.continuity + (candidate.objective_values.continuity ?? 0),
        preferred: state.preferred + (candidate.objective_values.preferred_provider ?? 0),
        startSum: state.startSum + candidate.start_slot,
        authorization,
      });
    }
    beam = prune(expanded, goals, strategy, Math.max(25, beamWidth));
  }

  return {
    states: beam.sort((a, b) => compareStates(b, a, goals, strategy)),
    timedOut: false,
  };
}

function prune(
  states: SearchState[],
  goals: ServiceGoal[],
  strategy: PlanStrategy,
  width: number,
): SearchState[] {
  states.sort((a, b) => compareStates(b, a, goals, strategy));
  const seen = new Set<string>();
  const out: SearchState[] = [];
  for (const state of states) {
    const authKey = Object.entries(state.authorization)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, slots]) => `${id}:${slots}`)
      .join(",");
    const selectedKey = state.selected.map((candidate) => candidate.candidate_id).join(",");
    const key = `${state.lastEnd}|${state.added.join(",")}|${state.sessions.join(",")}|${authKey}|${selectedKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(state);
    if (out.length >= width) break;
  }
  // Retaining the empty state keeps late-week-only and late-day options from
  // being pruned merely because early candidates accumulated points first.
  const empty = states.find((state) => state.selected.length === 0);
  if (empty && !out.includes(empty)) out[out.length - 1] = empty;
  return out;
}

function compareStates(
  a: SearchState,
  b: SearchState,
  goals: ServiceGoal[],
  strategy: PlanStrategy,
): number {
  const left = score(a, goals, strategy);
  const right = score(b, goals, strategy);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function score(state: SearchState, goals: ServiceGoal[], strategy: PlanStrategy): number[] {
  let requiredMet = 0;
  let minimumCoverage = 0;
  let targetsMet = 0;
  let targetCoverage = 0;
  let total = 0;
  for (let index = 0; index < goals.length; index += 1) {
    const goal = goals[index];
    const projectedSlots = Math.round(goal.current_hours * 4) + state.added[index];
    const minimumSlots = Math.round((goal.minimum_hours ?? 0) * 4);
    const targetSlots = Math.max(1, Math.round(goal.target_hours * 4));
    const projectedSessions = goal.current_sessions + state.sessions[index];
    const minimumSessions = goal.minimum_sessions ?? 0;
    const targetSessions = goal.target_sessions ?? minimumSessions;
    const minimumMet = projectedSlots >= minimumSlots && projectedSessions >= minimumSessions;
    const targetMet = projectedSlots >= targetSlots && projectedSessions >= targetSessions;
    if (goal.required && minimumMet) requiredMet += 1;
    if (targetMet) targetsMet += 1;
    const priorityWeight = Math.max(1, 201 - Math.min(200, goal.priority));
    minimumCoverage += Math.min(projectedSlots, Math.max(1, minimumSlots)) * priorityWeight;
    targetCoverage += Math.min(projectedSlots, targetSlots) * priorityWeight;
    total += state.added[index];
  }
  const clinical = [requiredMet, minimumCoverage, targetsMet, targetCoverage];
  switch (strategy) {
    case "CONTINUITY":
      return [...clinical, state.continuity, total, state.preferred, -state.selected.length, -state.startSum];
    case "FEWEST_VISITS":
      return [...clinical, total, -state.selected.length, state.continuity, state.preferred, -state.startSum];
    case "PREFERRED":
      return [...clinical, state.preferred, state.continuity, total, -state.selected.length, -state.startSum];
    case "EARLIEST":
      return [...clinical, total, -state.startSum, state.continuity, state.preferred, -state.selected.length];
    default:
      return [...clinical, total, state.continuity, state.preferred, -state.selected.length, -state.startSum];
  }
}

function reprovePlan(
  ctx: ScheduleContext,
  appointments: CandidateAppointment[],
  travel?: TravelModel,
): CandidateAppointment[] | null {
  const legal: CandidateAppointment[] = [];
  let working = ctx;
  for (const candidate of [...appointments].sort(candidateOrder)) {
    const result = evaluateBooking(
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
    if (!result.valid) return null;
    legal.push(candidate);
    working = working.withExtraAppointments(
      [candidateToAppointment(candidate, working)],
      candidate.resource_ids.map((resource_id) => ({
        appointment_id: candidate.candidate_id,
        resource_id,
      })),
    );
  }
  return legal;
}

/**
 * Turn an external solver's opaque candidate selection back into the exact
 * plan shape used by approval. Every candidate is re-evaluated against the
 * rule engine before the plan becomes approvable.
 */
export function buildOptimizedPlanFromCandidates(
  ctx: ScheduleContext,
  goals: ServiceGoal[],
  appointments: CandidateAppointment[],
  strategy: PlanStrategy,
  label: string,
  rationale: string,
  travel?: TravelModel,
  idPrefix = "plan_",
): OptimizedPlan | null {
  const legal = reprovePlan(ctx, appointments, travel);
  if (!legal || legal.length === 0) return null;
  const serviceMetrics = metricsFor(goals, legal);
  const requiredMet = serviceMetrics
    .filter((metric) => metric.required)
    .every((metric) => metric.minimum_met);
  const incumbentProviders = new Set(
    (ctx.appointmentsByPatient.get(legal[0].patient_id) ?? [])
      .filter((appointment) => appointment.provider_id)
      .map((appointment) => appointment.provider_id as UUID),
  );
  const providers = new Set(legal.map((candidate) => candidate.provider_id));
  return {
    id: `${idPrefix}${stableHash(planFingerprint(ctx, goals, legal, serviceMetrics))}`,
    strategy,
    label,
    rationale,
    appointments: legal,
    moves: [],
    service_metrics: serviceMetrics,
    added_hours: round(
      legal.reduce((total, candidate) => total + slotsToHours(candidate.duration_slots), 0),
    ),
    targets_met: serviceMetrics.filter((metric) => metric.target_met).length,
    required_services_met: requiredMet,
    provider_changes: [...providers].filter((provider) => !incumbentProviders.has(provider)).length,
    preferred_appointments: legal.filter(
      (candidate) => (candidate.objective_values.preferred_provider ?? 0) > 0,
    ).length,
    approvable: requiredMet,
  };
}

function metricsFor(goals: ServiceGoal[], appointments: CandidateAppointment[]): PlanServiceMetric[] {
  return goals.map((goal) => {
    const matching = appointments.filter((candidate) => candidate.service_id === goal.service_id);
    const added = slotsToHours(matching.reduce((sum, candidate) => sum + candidate.duration_slots, 0));
    const projected = round(goal.current_hours + added);
    const projectedSessions = goal.current_sessions + matching.length;
    const minimumMet =
      projected >= (goal.minimum_hours ?? 0) &&
      projectedSessions >= (goal.minimum_sessions ?? 0);
    const targetMet =
      projected >= goal.target_hours &&
      projectedSessions >= (goal.target_sessions ?? goal.minimum_sessions ?? 0);
    return {
      service_id: goal.service_id,
      service_name: goal.service_name,
      required: goal.required,
      current_hours: goal.current_hours,
      added_hours: round(added),
      projected_hours: projected,
      target_hours: goal.target_hours,
      target_met: targetMet,
      minimum_met: minimumMet,
      current_sessions: goal.current_sessions,
      added_sessions: matching.length,
      projected_sessions: projectedSessions,
      target_sessions: goal.target_sessions,
    };
  });
}

export function explainOptimizerShortfalls(
  goals: ServiceGoal[],
  plan: OptimizedPlan | undefined,
  rejectionCounts: Record<string, number | undefined>,
): OptimizationExplanation[] {
  const out: OptimizationExplanation[] = [];
  const metrics = new Map(plan?.service_metrics.map((metric) => [metric.service_id, metric]) ?? []);
  for (const goal of goals) {
    const projected = metrics.get(goal.service_id)?.projected_hours ?? goal.current_hours;
    if (projected >= goal.target_hours) continue;
    const gap = round(goal.target_hours - projected);
    if (goal.authorized_hours != null && goal.authorized_hours <= projected) {
      out.push({ service_id: goal.service_id, code: "AUTHORIZATION_CEILING", message: `${goal.service_name}: ${gap}h remains, but the authorization ceiling has been reached.` });
    } else if (goal.maximum_hours != null && goal.maximum_hours <= projected) {
      out.push({ service_id: goal.service_id, code: "CLINICAL_MAXIMUM", message: `${goal.service_name}: ${gap}h remains, but the clinical maximum has been reached.` });
    } else {
      out.push({ service_id: goal.service_id, code: "CAPACITY_SHORTFALL", message: `${goal.service_name}: ${gap}h of the weekly target could not be placed in a legal opening.` });
    }
  }
  const topRejection = Object.entries(rejectionCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])[0];
  if (topRejection && out.length > 0) {
    out.push({ code: topRejection[0], message: `${topRejection[1]} candidate times were rejected most often for ${humanizeCode(topRejection[0])}.` });
  }
  return out;
}

function explainNoCandidates(goals: ServiceGoal[]): OptimizationExplanation[] {
  if (goals.length === 0) return [{ code: "NO_SERVICES", message: "This patient has no active clinical requirements or authorizations to optimize." }];
  const unmet = goals.filter((goal) => !goalAlreadyMet(goal));
  if (unmet.length === 0) return [{ code: "TARGETS_ALREADY_MET", message: "Every configured service target is already met for this week." }];
  return unmet.map((goal) => ({
    service_id: goal.service_id,
    code: "NO_ADDABLE_CAPACITY",
    message: `${goal.service_name} cannot be increased without exceeding its authorization, clinical maximum, or session limit.`,
  }));
}

function goalAlreadyMet(goal: ServiceGoal): boolean {
  return goal.current_hours >= goal.target_hours && goal.current_sessions >= (goal.target_sessions ?? goal.minimum_sessions ?? 0);
}

function sessionLimit(goal: ServiceGoal): number {
  // addable_slots already respects the configured maximum. Target sessions are
  // not a ceiling, so absent a clinical maximum the number of 15-minute slots
  // is a safe finite upper bound.
  return goal.addable_sessions;
}

export function optimizerAuthorizationBudgets(
  ctx: ScheduleContext,
  patientId: UUID,
): Map<UUID, number> {
  const out = new Map<UUID, number>();
  for (const authorization of ctx.authorizations.get(patientId) ?? []) {
    if (authorization.status !== "ACTIVE") continue;
    const authorized = authorizationHours(authorization);
    if (authorized == null) {
      out.set(authorization.id, Number.POSITIVE_INFINITY);
      continue;
    }
    const used = ctx.slotsUsedAgainstAuthorization(authorization.id);
    out.set(authorization.id, Math.max(0, Math.floor(authorized * 60 / SLOT_MINUTES) - used));
  }
  return out;
}

function authorizationHours(authorization: {
  authorized_hours: number | null;
  authorized_units: number | null;
  units_per_hour: number;
}): number | null {
  if (authorization.authorized_hours != null) return authorization.authorized_hours;
  if (authorization.authorized_units != null && authorization.units_per_hour > 0) {
    return authorization.authorized_units / authorization.units_per_hour;
  }
  return null;
}

export function compareOptimizedPlans(a: OptimizedPlan, b: OptimizedPlan): number {
  return (
    Number(b.required_services_met) - Number(a.required_services_met) ||
    b.targets_met - a.targets_met ||
    b.added_hours - a.added_hours ||
    a.moves.length - b.moves.length ||
    a.provider_changes - b.provider_changes ||
    a.appointments.length - b.appointments.length ||
    a.id.localeCompare(b.id)
  );
}

function candidateOrder(a: CandidateAppointment, b: CandidateAppointment): number {
  return a.start_slot - b.start_slot || a.end_slot - b.end_slot || a.candidate_id.localeCompare(b.candidate_id);
}

function planFingerprint(
  ctx: ScheduleContext,
  goals: ServiceGoal[],
  appointments: CandidateAppointment[],
  metrics: PlanServiceMetric[],
): string {
  return JSON.stringify({
    patient_id: appointments[0]?.patient_id ?? null,
    week_start: ctx.grid.startDate,
    goals: goals.map((goal) => ({
      service_id: goal.service_id,
      required: goal.required,
      priority: goal.priority,
      current_hours: goal.current_hours,
      minimum_hours: goal.minimum_hours,
      target_hours: goal.target_hours,
      maximum_hours: goal.maximum_hours,
      authorized_hours: goal.authorized_hours,
      current_sessions: goal.current_sessions,
      minimum_sessions: goal.minimum_sessions,
      target_sessions: goal.target_sessions,
      maximum_sessions: goal.maximum_sessions,
    })),
    appointments: [...appointments].sort(candidateOrder).map((candidate) => ({
      candidate_id: candidate.candidate_id,
      service_id: candidate.service_id,
      provider_id: candidate.provider_id,
      authorization_id: candidate.authorization_id,
      location_id: candidate.location_id,
      resource_ids: [...candidate.resource_ids].sort(),
      start_slot: candidate.start_slot,
      end_slot: candidate.end_slot,
      objective_values: candidate.objective_values,
    })),
    metrics,
  });
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function humanizeCode(code: string): string {
  return code.toLowerCase().replaceAll("_", " ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
