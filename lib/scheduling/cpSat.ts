import { createHash } from "node:crypto";

import { hoursToSlots, SLOT_MINUTES } from "../domain/slots";
import type { CandidateAppointment, UUID } from "../domain/types";
import type { ScheduleContext } from "../rules/context";
import type { TravelModel } from "../rules/travel";
import { logEvent } from "../observability/logger";
import { generateCandidates } from "./candidates";
import { readCpSatConfig } from "./cpSatConfig";
import {
  buildOptimizedPlanFromCandidates,
  compareOptimizedPlans,
  explainOptimizerShortfalls,
  optimizePatientWeek,
  optimizerAuthorizationBudgets,
  reduceOptimizerCandidates,
  type OptimizePatientWeekRequest,
  type OptimizedPlan,
  type PatientWeekOptimization,
  type PlanStrategy,
  type SolverStatus,
} from "./optimizer";

interface SolverPlanResponse {
  strategy: PlanStrategy;
  candidate_ids: string[];
  optimal: boolean;
}

interface SolverResponse {
  version: 1;
  status: SolverStatus;
  plans: SolverPlanResponse[];
  runtime_ms: number;
  branches: number;
  conflicts: number;
}

const STRATEGIES: PlanStrategy[] = [
  "BALANCED",
  "CONTINUITY",
  "FEWEST_VISITS",
  "PREFERRED",
  "EARLIEST",
];

const PRESENTATION: Record<PlanStrategy, { label: string; rationale: string }> = {
  BALANCED: {
    label: "Best clinical coverage",
    rationale: "Uses CP-SAT to complete required services first, then close the largest target gaps.",
  },
  CONTINUITY: {
    label: "Strongest continuity",
    rationale: "Uses CP-SAT to retain existing clinicians where clinical coverage is comparable.",
  },
  FEWEST_VISITS: {
    label: "Fewest visits",
    rationale: "Uses CP-SAT to favor longer sessions after clinical coverage is protected.",
  },
  PREFERRED: {
    label: "Patient preferences",
    rationale: "Uses CP-SAT to favor preferred clinicians after required care is protected.",
  },
  EARLIEST: {
    label: "Earliest completion",
    rationale: "Uses CP-SAT to place comparable clinical coverage as early in the week as possible.",
  },
};

export class CpSatUnavailableError extends Error {
  constructor() {
    super("The scheduling optimizer is temporarily unavailable.");
    this.name = "CpSatUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function solverCandidateToken(candidateId: string) {
  return `candidate_${createHash("sha256").update(candidateId).digest("hex")}`;
}

function parseSolverResponse(value: unknown, candidates: Map<string, CandidateAppointment>): SolverResponse {
  if (!isRecord(value) || value.version !== 1) throw new Error("INVALID_RESPONSE_VERSION");
  if (!(["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"] as unknown[]).includes(value.status)) {
    throw new Error("INVALID_RESPONSE_STATUS");
  }
  if (!Array.isArray(value.plans) || value.plans.length > 5) throw new Error("INVALID_RESPONSE_PLANS");
  const plans: SolverPlanResponse[] = value.plans.map((raw) => {
    if (!isRecord(raw) || !STRATEGIES.includes(raw.strategy as PlanStrategy)) {
      throw new Error("INVALID_RESPONSE_STRATEGY");
    }
    if (!Array.isArray(raw.candidate_ids) || raw.candidate_ids.some((id) => typeof id !== "string")) {
      throw new Error("INVALID_RESPONSE_CANDIDATES");
    }
    const candidateIds = raw.candidate_ids as string[];
    if (new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => !candidates.has(id))) {
      throw new Error("INVALID_RESPONSE_CANDIDATES");
    }
    if (typeof raw.optimal !== "boolean") throw new Error("INVALID_RESPONSE_OPTIMALITY");
    return {
      strategy: raw.strategy as PlanStrategy,
      candidate_ids: candidateIds,
      optimal: raw.optimal,
    };
  });
  for (const name of ["runtime_ms", "branches", "conflicts"] as const) {
    if (!Number.isSafeInteger(value[name]) || Number(value[name]) < 0) {
      throw new Error("INVALID_RESPONSE_METRICS");
    }
  }
  return {
    version: 1,
    status: value.status as SolverStatus,
    plans,
    runtime_ms: Number(value.runtime_ms),
    branches: Number(value.branches),
    conflicts: Number(value.conflicts),
  };
}

export function buildCpSatIncompatibilities(
  candidates: CandidateAppointment[],
  travel: TravelModel | undefined,
): { left: number; right: number }[] {
  if (!travel?.enforceAsHardConstraint) return [];
  const byProvider = new Map<UUID, { candidate: CandidateAppointment; index: number }[]>();
  candidates.forEach((candidate, index) => {
    const bucket = byProvider.get(candidate.provider_id);
    const entry = { candidate, index };
    if (bucket) bucket.push(entry);
    else byProvider.set(candidate.provider_id, [entry]);
  });
  const pairs: { left: number; right: number }[] = [];
  for (const entries of byProvider.values()) {
    entries.sort((a, b) => a.candidate.start_slot - b.candidate.start_slot || a.index - b.index);
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      const left = entries[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const right = entries[rightIndex];
        if (right.candidate.start_slot < left.candidate.end_slot) continue;
        const gapMinutes = (right.candidate.start_slot - left.candidate.end_slot) * SLOT_MINUTES;
        const needed = travel.minutesBetween(left.candidate.location_id, right.candidate.location_id);
        if (needed > gapMinutes) {
          pairs.push({ left: Math.min(left.index, right.index), right: Math.max(left.index, right.index) });
          if (pairs.length > 500_000) throw new Error("INCOMPATIBILITY_LIMIT");
        }
      }
    }
  }
  return pairs.sort((a, b) => a.left - b.left || a.right - b.right);
}

function deduplicatePlans(plans: OptimizedPlan[], maximum: number) {
  const seen = new Set<string>();
  return plans
    .sort(compareOptimizedPlans)
    .filter((plan) => {
      const signature = JSON.stringify({
        candidates: plan.appointments.map((candidate) => candidate.candidate_id).sort(),
        moves: plan.moves.map((move) => [move.appointment_id, move.replacement.candidate_id]).sort(),
      });
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .slice(0, maximum);
}

function fallback(
  baseline: PatientWeekOptimization,
  reason: string,
  required: boolean,
): PatientWeekOptimization {
  logEvent("warn", "optimizer.cp_sat_fallback", { error_code: reason });
  if (required) throw new CpSatUnavailableError();
  return { ...baseline, meta: { ...baseline.meta, fallback_reason: reason } };
}

export async function optimizePatientWeekWithSolver(
  ctx: ScheduleContext,
  request: OptimizePatientWeekRequest,
): Promise<PatientWeekOptimization> {
  const started = Date.now();
  const baseline = optimizePatientWeek(ctx, request);
  let config;
  try {
    config = readCpSatConfig();
  } catch {
    return fallback(
      baseline,
      "CONFIGURATION_INVALID",
      process.env.CP_SAT_REQUIRED?.trim().toLowerCase() === "true",
    );
  }
  if (!config || baseline.status === "TARGETS_MET" || baseline.goals.every((goal) => goal.addable_slots <= 0)) {
    return baseline;
  }

  const generation = generateCandidates(ctx, {
    patient_id: request.patient_id,
    service_ids: baseline.goals.filter((goal) => goal.addable_slots > 0).map((goal) => goal.service_id),
    includeExisting: false,
    startStepSlots: request.start_step_slots ?? 2,
    maxCandidates: 12_000,
    travel: request.travel,
  });
  const reduced = reduceOptimizerCandidates(generation.candidates, config.maxCandidates);
  const goalByService = new Map(baseline.goals.map((goal) => [goal.service_id, goal]));
  const candidates = reduced.candidates.filter((candidate) => {
    const goal = goalByService.get(candidate.service_id);
    return Boolean(goal && candidate.duration_slots <= goal.addable_slots);
  });
  if (candidates.length === 0) return baseline;
  // Candidate IDs contain placement details in the application model. Replace
  // them with one-way tokens before crossing the service boundary so location
  // and resource IDs are not indirectly disclosed.
  const solverCandidates = candidates.map((candidate) => ({
    token: solverCandidateToken(candidate.candidate_id),
    candidate,
  }));
  const byId = new Map(solverCandidates.map(({ token, candidate }) => [token, candidate]));
  const authorizationLimits = Object.fromEntries(
    [...optimizerAuthorizationBudgets(ctx, request.patient_id)]
      .filter(([, slots]) => Number.isFinite(slots))
      .map(([authorizationId, slots]) => [authorizationId, slots]),
  );

  let incompatibilities;
  try {
    incompatibilities = buildCpSatIncompatibilities(candidates, request.travel);
  } catch {
    return fallback(baseline, "INCOMPATIBILITY_LIMIT", config.required);
  }
  const payload = {
    version: 1,
    goals: baseline.goals.map((goal) => ({
      service_id: goal.service_id,
      required: goal.required,
      priority: Math.max(0, Math.min(10_000, goal.priority)),
      current_slots: hoursToSlots(goal.current_hours),
      minimum_slots: hoursToSlots(goal.minimum_hours ?? 0),
      target_slots: hoursToSlots(goal.target_hours),
      addable_slots: goal.addable_slots,
      current_sessions: goal.current_sessions,
      minimum_sessions: goal.minimum_sessions ?? 0,
      target_sessions: goal.target_sessions ?? goal.minimum_sessions ?? 0,
      addable_sessions: Number.isFinite(goal.addable_sessions)
        ? Math.min(10_000, goal.addable_sessions)
        : Math.min(10_000, candidates.filter((candidate) => candidate.service_id === goal.service_id).length),
    })),
    candidates: solverCandidates.map(({ token, candidate }) => ({
      candidate_id: token,
      service_id: candidate.service_id,
      provider_id: candidate.provider_id,
      authorization_id: candidate.authorization_id,
      start_slot: candidate.start_slot,
      end_slot: candidate.end_slot,
      duration_slots: candidate.duration_slots,
      continuity: (candidate.objective_values.continuity ?? 0) > 0 ? 1 : 0,
      preferred: (candidate.objective_values.preferred_provider ?? 0) > 0 ? 1 : 0,
    })),
    authorization_limits: authorizationLimits,
    incompatibilities,
    strategies: STRATEGIES.slice(0, Math.max(1, Math.min(5, request.max_solutions ?? 4))),
    max_solutions: Math.max(1, Math.min(5, request.max_solutions ?? 4)),
    time_limit_seconds: config.timeLimitSeconds,
  };

  let response: SolverResponse;
  try {
    const result = await fetch(`${config.url}/v1/optimize`, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!result.ok) throw new Error(`HTTP_${result.status}`);
    response = parseSolverResponse(await result.json(), byId);
  } catch (error) {
    const reason = error instanceof Error && /^HTTP_\d{3}$/.test(error.message)
      ? error.message
      : error instanceof Error && error.name === "TimeoutError"
        ? "TIMEOUT"
        : "REQUEST_FAILED";
    return fallback(baseline, reason, config.required);
  }

  const cpPlans = response.plans.flatMap((solverPlan) => {
    const presentation = PRESENTATION[solverPlan.strategy];
    const plan = buildOptimizedPlanFromCandidates(
      ctx,
      baseline.goals,
      solverPlan.candidate_ids.map((id) => byId.get(id)!),
      solverPlan.strategy,
      presentation.label,
      presentation.rationale,
      request.travel,
      "cpsat_",
    );
    return plan ? [plan] : [];
  });
  if (response.plans.length > 0 && cpPlans.length === 0) {
    return fallback(baseline, "RULE_REVALIDATION_FAILED", config.required);
  }

  const maximum = Math.max(1, Math.min(5, request.max_solutions ?? 4));
  const plans = deduplicatePlans([...cpPlans, ...baseline.plans], maximum);
  const best = plans.find((plan) => plan.approvable);
  const targetsMet = Boolean(best?.service_metrics.every((metric) => metric.target_met));
  const completeCandidateSet = !generation.truncated && !reduced.reduced;
  const topIsCpSat = Boolean(best?.id.startsWith("cpsat_"));
  const optimalityProven = response.status === "OPTIMAL" && completeCandidateSet && topIsCpSat;
  const status = targetsMet
    ? "TARGETS_MET"
    : response.status !== "OPTIMAL" || !completeCandidateSet || baseline.meta.search_limit_reached
      ? "BOUNDED"
      : best
        ? "FEASIBLE"
        : "INFEASIBLE";

  return {
    ...baseline,
    status,
    plans,
    explanations: explainOptimizerShortfalls(baseline.goals, best, generation.rejectionsByCode),
    meta: {
      ...baseline.meta,
      engine: "PYTHON_CP_SAT",
      solver_status: response.status,
      optimality_proven: optimalityProven,
      fallback_reason: null,
      generated_candidates: generation.candidates.length,
      searched_candidates: candidates.length,
      rejected_candidates: generation.rejected,
      candidate_generation_truncated: generation.truncated,
      search_reduced: reduced.reduced,
      search_limit_reached: response.status !== "OPTIMAL",
      runtime_ms: Date.now() - started,
    },
  };
}
