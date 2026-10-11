/**
 * Deterministic schedule-recovery suggestions.
 *
 * This module is intentionally read-only. It removes only disrupted movable
 * visits from a cloned ScheduleContext, asks the existing candidate/rule
 * engine for legal replacements, and places recommendations into another
 * in-memory clone so a multi-appointment callout cannot recommend colliding
 * visits. Persisting a selected option remains a separate, atomic workflow.
 */

import { SLOT_MINUTES, overlaps, type SlotRange } from "../domain/slots";
import type { CandidateAppointment, UUID } from "../domain/types";
import { ScheduleContext, type BookedAppointment } from "../rules/context";
import { evaluateBooking, type ProposedBooking } from "../rules/engine";
import type { ViolationCode } from "../rules/violations";
import { candidateToAppointment, generateCandidates } from "../scheduling/candidates";
import type {
  AffectedAppointmentRecovery,
  RecoveryExplanation,
  RecoveryOption,
  ScheduleRecoveryOptions,
  ScheduleRecoveryRequest,
  ScheduleRecoveryResult,
} from "./types";

const DEFAULT_MAX_OPTIONS = 8;
const DEFAULT_MAX_CANDIDATES = 20_000;
const MAX_OPTIONS = 25;
const MAX_CANDIDATES = 50_000;
const RECOVERABLE_STATUSES = new Set(["SCHEDULED", "CONFIRMED"]);

interface InternalCandidate {
  key: string;
  patient_id: UUID;
  provider_id: UUID;
  service_id: UUID;
  authorization_id: UUID | null;
  location_id: UUID | null;
  resource_ids: UUID[];
  range: SlotRange;
  telehealth: boolean;
  sourceCandidate?: CandidateAppointment;
}

interface CandidateSearch {
  candidates: InternalCandidate[];
  rejections: Partial<Record<ViolationCode, number>>;
}

/**
 * Build legal recovery choices without mutating the supplied context.
 *
 * Output intentionally omits patient identity. Appointment/provider/service
 * IDs are operational references; explanation text contains no person names
 * or other direct identifiers.
 */
export function suggestScheduleRecovery(
  ctx: ScheduleContext,
  request: ScheduleRecoveryRequest,
  options: ScheduleRecoveryOptions = {},
): ScheduleRecoveryResult {
  const validation = validateRequest(ctx, request);
  if (validation) return emptyResult(validation);

  const affected = affectedAppointments(ctx, request);
  if (affected.length === 0) {
    return emptyResult({
      code: "NO_APPOINTMENTS_AFFECTED",
      message: "No scheduled or confirmed appointments are affected in this window.",
    });
  }

  const locked = affected.filter((appointment) => appointment.scheduling_flexibility === "LOCKED");
  const movable = affected.filter((appointment) => appointment.scheduling_flexibility !== "LOCKED");
  const removedIds = new Set(movable.map((appointment) => appointment.id));
  let working = withoutAppointments(ctx, removedIds);
  const excludedProviders = new Set<UUID>(
    request.kind === "PROVIDER_UNAVAILABILITY"
      ? [request.provider_id]
      : request.excluded_provider_ids ?? [],
  );

  const maxOptions = clampInteger(
    options.max_options_per_appointment,
    DEFAULT_MAX_OPTIONS,
    1,
    MAX_OPTIONS,
  );
  const maxCandidates = clampInteger(
    options.max_candidates_per_appointment,
    DEFAULT_MAX_CANDIDATES,
    1,
    MAX_CANDIDATES,
  );
  const startStepSlots = clampInteger(options.start_step_slots, 1, 1, 16);
  const minimumStartSlot = recoveryMinimumStartSlot(ctx, options.not_before);
  const recoveries: AffectedAppointmentRecovery[] = [];

  for (const appointment of locked) {
    recoveries.push({
      appointment_id: appointment.id,
      service_id: appointment.service_id,
      flexibility: appointment.scheduling_flexibility,
      disposition: "LOCKED_PRESERVED",
      original_start_slot: appointment.range.startSlot,
      original_end_slot: appointment.range.endSlot,
      recommended_option_id: null,
      options: [],
      explanations: [
        {
          code: "LOCKED_VISIT_PRESERVED",
          message: "This locked visit was preserved and requires explicit human handling.",
        },
      ],
    });
  }

  for (const appointment of movable) {
    const search = findCandidates(
      working,
      appointment,
      excludedProviders,
      startStepSlots,
      maxCandidates,
      minimumStartSlot,
      options.travel,
    );
    const ranked = search.candidates
      .filter((candidate) => !isUnchanged(candidate, appointment))
      .filter(
        (candidate) =>
          !options.not_before ||
          ctx.grid.instantOf(candidate.range.startSlot).getTime() >= options.not_before.getTime(),
      )
      .sort((left, right) => compareCandidates(left, right, appointment))
      .slice(0, maxOptions);
    const recoveryOptions = ranked.map((candidate) => toRecoveryOption(ctx, appointment, candidate));
    const recommended = ranked[0];

    if (recommended) {
      working = placeCandidate(working, recommended, appointment.scheduling_flexibility);
    }

    recoveries.push({
      appointment_id: appointment.id,
      service_id: appointment.service_id,
      flexibility: appointment.scheduling_flexibility,
      disposition: recommended ? "RECOVERED" : "NO_ALTERNATIVE",
      original_start_slot: appointment.range.startSlot,
      original_end_slot: appointment.range.endSlot,
      recommended_option_id: recoveryOptions[0]?.id ?? null,
      options: recoveryOptions,
      explanations: recommended
        ? recoveryOptions[0].explanations
        : noAlternativeExplanations(search.rejections),
    });
  }

  recoveries.sort(compareRecoveries);
  const recoveredCount = recoveries.filter((item) => item.disposition === "RECOVERED").length;
  const lockedCount = recoveries.filter((item) => item.disposition === "LOCKED_PRESERVED").length;
  const unresolvedCount = recoveries.length - recoveredCount;
  const status = recoveryStatus(recoveries.length, recoveredCount, unresolvedCount);

  return {
    status,
    affected_count: recoveries.length,
    recovered_count: recoveredCount,
    locked_preserved_count: lockedCount,
    unresolved_count: unresolvedCount,
    appointments: recoveries,
    explanations: resultExplanations(status, recoveredCount, unresolvedCount, lockedCount),
  };
}

function validateRequest(
  ctx: ScheduleContext,
  request: ScheduleRecoveryRequest,
): RecoveryExplanation | null {
  if (request.kind === "APPOINTMENT") {
    const appointment = ctx.appointments.find((row) => row.id === request.appointment_id);
    if (!appointment) {
      return {
        code: "APPOINTMENT_NOT_FOUND",
        message: "The requested appointment is not present in this scheduling horizon.",
      };
    }
    if (!RECOVERABLE_STATUSES.has(appointment.status)) {
      return {
        code: "APPOINTMENT_NOT_RECOVERABLE",
        message: "Only scheduled or confirmed appointments can be recovered.",
      };
    }
    return null;
  }

  const { startSlot, endSlot } = request.unavailable_range;
  if (
    !Number.isInteger(startSlot) ||
    !Number.isInteger(endSlot) ||
    startSlot < 0 ||
    endSlot > ctx.grid.totalSlots ||
    startSlot >= endSlot
  ) {
    return {
      code: "INVALID_UNAVAILABILITY_RANGE",
      message: "The provider-unavailability window must be a valid range inside this horizon.",
    };
  }
  return null;
}

function affectedAppointments(
  ctx: ScheduleContext,
  request: ScheduleRecoveryRequest,
): BookedAppointment[] {
  const rows =
    request.kind === "APPOINTMENT"
      ? ctx.appointments.filter((appointment) => appointment.id === request.appointment_id)
      : (ctx.appointmentsByProvider.get(request.provider_id) ?? []).filter((appointment) =>
          overlaps(appointment.range, request.unavailable_range),
        );

  return rows
    .filter((appointment) => RECOVERABLE_STATUSES.has(appointment.status))
    .sort(
      (left, right) =>
        flexibilityOrder(left) - flexibilityOrder(right) ||
        left.range.startSlot - right.range.startSlot ||
        left.range.endSlot - right.range.endSlot ||
        left.id.localeCompare(right.id),
    );
}

function flexibilityOrder(appointment: BookedAppointment): number {
  if (appointment.scheduling_flexibility === "LOCKED") return 0;
  if (appointment.scheduling_flexibility === "PROTECTED") return 1;
  return 2;
}

function withoutAppointments(ctx: ScheduleContext, ids: ReadonlySet<UUID>): ScheduleContext {
  if (ids.size === 0) return ctx;
  return new ScheduleContext(ctx.grid, {
    ...ctx.rows,
    appointments: ctx.rows.appointments.filter((appointment) => !ids.has(appointment.id)),
    appointmentResources: ctx.rows.appointmentResources.filter(
      (link) => !ids.has(link.appointment_id),
    ),
  });
}

function findCandidates(
  ctx: ScheduleContext,
  appointment: BookedAppointment,
  excludedProviders: ReadonlySet<UUID>,
  startStepSlots: number,
  maxCandidates: number,
  minimumStartSlot: number,
  travel: ScheduleRecoveryOptions["travel"],
): CandidateSearch {
  if (appointment.telehealth) {
    return findTelehealthCandidates(
      ctx,
      appointment,
      excludedProviders,
      startStepSlots,
      maxCandidates,
      minimumStartSlot,
      travel,
    );
  }

  // Exclude unavailable providers before enumeration. Filtering afterward is
  // unsafe under a candidate cap: an unavailable provider could consume the
  // entire bound and hide a valid replacement that sorts later.
  const searchContext = withExcludedProviders(ctx, excludedProviders);
  // At most one candidate can be the exact unchanged booking. Give generation
  // one extra position, remove that no-op, then enforce the caller's bound.
  const generationLimit = Math.min(MAX_CANDIDATES, maxCandidates + 1);
  const generated = generateCandidates(searchContext, {
    patient_id: appointment.patient_id,
    service_ids: [appointment.service_id],
    durations: [(appointment.range.endSlot - appointment.range.startSlot) * SLOT_MINUTES],
    startStepSlots,
    includeExisting: false,
    maxCandidates: generationLimit,
    minimumStartSlot,
    travel,
  });

  return {
    candidates: generated.candidates
      .map((candidate) => ({
        key: candidate.candidate_id,
        patient_id: candidate.patient_id,
        provider_id: candidate.provider_id,
        service_id: candidate.service_id,
        authorization_id: candidate.authorization_id,
        location_id: candidate.location_id,
        resource_ids: [...candidate.resource_ids].sort((a, b) => a.localeCompare(b)),
        range: { startSlot: candidate.start_slot, endSlot: candidate.end_slot },
        telehealth: false,
        sourceCandidate: candidate,
      }))
      .filter((candidate) => !isUnchanged(candidate, appointment))
      .slice(0, maxCandidates),
    rejections: generated.rejectionsByCode,
  };
}

function withExcludedProviders(
  ctx: ScheduleContext,
  excludedProviders: ReadonlySet<UUID>,
): ScheduleContext {
  if (excludedProviders.size === 0) return ctx;
  return new ScheduleContext(ctx.grid, {
    ...ctx.rows,
    providers: ctx.rows.providers.map((provider) =>
      excludedProviders.has(provider.id) ? { ...provider, status: "ON_LEAVE" as const } : provider,
    ),
  });
}

/** Candidate generation currently enumerates in-person bookings only. */
function findTelehealthCandidates(
  ctx: ScheduleContext,
  appointment: BookedAppointment,
  excludedProviders: ReadonlySet<UUID>,
  startStepSlots: number,
  maxCandidates: number,
  minimumStartSlot: number,
  travel: ScheduleRecoveryOptions["travel"],
): CandidateSearch {
  const duration = appointment.range.endSlot - appointment.range.startSlot;
  const service = ctx.services.get(appointment.service_id);
  const authorizations = service?.requires_authorization
    ? ctx
        .authorizationsFor(appointment.patient_id, appointment.service_id)
        .filter((authorization) => authorization.status === "ACTIVE")
    : [null];
  const rejections: Partial<Record<ViolationCode, number>> = {};
  const candidates: InternalCandidate[] = [];

  outer: for (const provider of ctx.eligibleProviders(appointment.service_id)) {
    if (excludedProviders.has(provider.id)) continue;
    const windows = ctx
      .meetingWindows(appointment.patient_id, provider.id, appointment.service_id)
      .sort((a, b) => a.startSlot - b.startSlot || a.endSlot - b.endSlot);
    for (const authorization of authorizations) {
      for (const window of windows) {
        const firstStart = window.startSlot + Math.ceil(
          Math.max(0, minimumStartSlot - window.startSlot) / startStepSlots,
        ) * startStepSlots;
        for (
          let startSlot = firstStart;
          startSlot + duration <= window.endSlot;
          startSlot += startStepSlots
        ) {
          const range = { startSlot, endSlot: startSlot + duration };
          const proposal: ProposedBooking = {
            patient_id: appointment.patient_id,
            service_id: appointment.service_id,
            provider_id: provider.id,
            location_id: appointment.location_id,
            authorization_id: authorization?.id ?? null,
            resource_ids: [],
            range,
            telehealth: true,
          };
          const proof = evaluateBooking(proposal, ctx, {
            includeSoft: false,
            stopAfterFirstHard: true,
            travel,
          });
          if (!proof.valid) {
            const code = proof.violations.find((violation) => violation.severity === "HARD")?.code;
            if (code) rejections[code] = (rejections[code] ?? 0) + 1;
            continue;
          }

          const candidate: InternalCandidate = {
            key: [
              "telehealth",
              appointment.service_id,
              provider.id,
              authorization?.id ?? "no-auth",
              startSlot,
              duration,
            ].join(":"),
            patient_id: appointment.patient_id,
            provider_id: provider.id,
            service_id: appointment.service_id,
            authorization_id: authorization?.id ?? null,
            location_id: appointment.location_id,
            resource_ids: [],
            range,
            telehealth: true,
          };
          // A no-op is never a recovery option and must not consume the
          // deterministic candidate budget.
          if (isUnchanged(candidate, appointment)) continue;
          candidates.push(candidate);
          if (candidates.length >= maxCandidates) break outer;
        }
      }
    }
  }

  return { candidates, rejections };
}

function recoveryMinimumStartSlot(ctx: ScheduleContext, notBefore?: Date): number {
  if (!notBefore || notBefore.getTime() <= ctx.grid.dayStart(0).getTime()) return 0;
  if (notBefore.getTime() >= ctx.grid.horizonEnd().getTime()) return ctx.grid.totalSlots;
  return ctx.grid.slotCeilOf(notBefore) ?? ctx.grid.totalSlots;
}

function isUnchanged(candidate: InternalCandidate, appointment: BookedAppointment): boolean {
  return (
    candidate.provider_id === appointment.provider_id &&
    candidate.authorization_id === appointment.authorization_id &&
    candidate.location_id === appointment.location_id &&
    candidate.telehealth === appointment.telehealth &&
    candidate.range.startSlot === appointment.range.startSlot &&
    candidate.range.endSlot === appointment.range.endSlot &&
    sameIds(candidate.resource_ids, appointment.resource_ids)
  );
}

function sameIds(left: readonly UUID[], right: readonly UUID[]): boolean {
  const a = [...left].sort((x, y) => x.localeCompare(y));
  const b = [...right].sort((x, y) => x.localeCompare(y));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareCandidates(
  left: InternalCandidate,
  right: InternalCandidate,
  original: BookedAppointment,
): number {
  const leftSameTime = sameRange(left.range, original.range);
  const rightSameTime = sameRange(right.range, original.range);
  const leftSameTimeReplacement = leftSameTime && left.provider_id !== original.provider_id;
  const rightSameTimeReplacement = rightSameTime && right.provider_id !== original.provider_id;
  const leftDistance = Math.abs(left.range.startSlot - original.range.startSlot);
  const rightDistance = Math.abs(right.range.startSlot - original.range.startSlot);

  return (
    Number(rightSameTimeReplacement) - Number(leftSameTimeReplacement) ||
    leftDistance - rightDistance ||
    Number(right.provider_id === original.provider_id) -
      Number(left.provider_id === original.provider_id) ||
    Number(right.location_id === original.location_id) -
      Number(left.location_id === original.location_id) ||
    left.range.startSlot - right.range.startSlot ||
    left.range.endSlot - right.range.endSlot ||
    left.provider_id.localeCompare(right.provider_id) ||
    (left.location_id ?? "").localeCompare(right.location_id ?? "") ||
    left.resource_ids.join(",").localeCompare(right.resource_ids.join(",")) ||
    left.key.localeCompare(right.key)
  );
}

function sameRange(left: SlotRange, right: SlotRange): boolean {
  return left.startSlot === right.startSlot && left.endSlot === right.endSlot;
}

function toRecoveryOption(
  ctx: ScheduleContext,
  original: BookedAppointment,
  candidate: InternalCandidate,
): RecoveryOption {
  const sameTime = sameRange(candidate.range, original.range);
  const providerChanged = candidate.provider_id !== original.provider_id;
  const shiftMinutes = (candidate.range.startSlot - original.range.startSlot) * SLOT_MINUTES;
  const explanation: RecoveryExplanation =
    sameTime && providerChanged
      ? {
          code: "SAME_TIME_PROVIDER_REPLACEMENT",
          message: "A qualified replacement provider is available at the original time.",
        }
      : {
          code: "NEARBY_SLOT",
          message:
            shiftMinutes === 0
              ? "A legal replacement is available at the original time with another booking detail changed."
              : `The nearest legal replacement starts ${Math.abs(shiftMinutes)} minutes ${
                  shiftMinutes < 0 ? "earlier" : "later"
                } than the original visit.`,
        };

  return {
    id: optionId(original.id, candidate),
    provider_id: candidate.provider_id,
    service_id: candidate.service_id,
    authorization_id: candidate.authorization_id,
    location_id: candidate.location_id,
    resource_ids: [...candidate.resource_ids],
    start_slot: candidate.range.startSlot,
    end_slot: candidate.range.endSlot,
    start_time: ctx.grid.instantOf(candidate.range.startSlot).toISOString(),
    end_time: ctx.grid.instantOf(candidate.range.endSlot).toISOString(),
    telehealth: candidate.telehealth,
    same_time: sameTime,
    provider_changed: providerChanged,
    time_shift_minutes: shiftMinutes,
    explanations: [explanation],
  };
}

function optionId(appointmentId: UUID, candidate: InternalCandidate): string {
  // Every booking field that changes legality or persistence participates in
  // identity. In particular, two visually identical choices backed by
  // different authorizations must never share an approval token.
  return [
    "recovery",
    appointmentId,
    candidate.service_id,
    candidate.provider_id,
    candidate.authorization_id ?? "no-auth",
    candidate.location_id ?? "remote",
    candidate.telehealth ? "telehealth" : "in-person",
    candidate.range.startSlot,
    candidate.range.endSlot,
    [...candidate.resource_ids].sort((a, b) => a.localeCompare(b)).join(",") || "no-resource",
  ].join(":");
}

function placeCandidate(
  ctx: ScheduleContext,
  candidate: InternalCandidate,
  flexibility: BookedAppointment["scheduling_flexibility"],
): ScheduleContext {
  const appointment = candidate.sourceCandidate
    ? candidateToAppointment(
        { ...candidate.sourceCandidate, flexibility },
        ctx,
      )
    : {
        id: candidate.key,
        patient_id: candidate.patient_id,
        service_id: candidate.service_id,
        provider_id: candidate.provider_id,
        authorization_id: candidate.authorization_id,
        location_id: candidate.location_id,
        start_time: ctx.grid.instantOf(candidate.range.startSlot).toISOString(),
        end_time: ctx.grid.instantOf(candidate.range.endSlot).toISOString(),
        status: "SCHEDULED" as const,
        scheduling_flexibility: flexibility,
        telehealth: candidate.telehealth,
        original_start_time: null,
        original_provider_id: null,
        original_location_id: null,
      };

  return ctx.withExtraAppointments(
    [appointment],
    candidate.resource_ids.map((resourceId) => ({
      appointment_id: appointment.id,
      resource_id: resourceId,
    })),
  );
}

function noAlternativeExplanations(
  rejections: Partial<Record<ViolationCode, number>>,
): RecoveryExplanation[] {
  const top = Object.entries(rejections)
    .filter((entry): entry is [ViolationCode, number] => entry[1] != null && entry[1] > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  return [
    {
      code: "NO_LEGAL_ALTERNATIVE",
      message: top
        ? "No legal alternative fits the current clinical, availability, authorization, and resource rules."
        : "No qualified replacement option is available in this scheduling horizon.",
      limiting_rule: top?.[0],
      count: top?.[1],
    },
  ];
}

function compareRecoveries(
  left: AffectedAppointmentRecovery,
  right: AffectedAppointmentRecovery,
): number {
  return (
    left.original_start_slot - right.original_start_slot ||
    left.original_end_slot - right.original_end_slot ||
    left.appointment_id.localeCompare(right.appointment_id)
  );
}

function recoveryStatus(
  affectedCount: number,
  recoveredCount: number,
  unresolvedCount: number,
): ScheduleRecoveryResult["status"] {
  if (affectedCount === 0) return "NO_IMPACT";
  if (unresolvedCount === 0) return "RECOVERED";
  if (recoveredCount === 0) return "BLOCKED";
  return "PARTIAL";
}

function resultExplanations(
  status: ScheduleRecoveryResult["status"],
  recoveredCount: number,
  unresolvedCount: number,
  lockedCount: number,
): RecoveryExplanation[] {
  const explanations: RecoveryExplanation[] = [];
  if (lockedCount > 0) {
    explanations.push({
      code: "LOCKED_VISIT_PRESERVED",
      message: `${lockedCount} locked visit${lockedCount === 1 ? " was" : "s were"} preserved.`,
      count: lockedCount,
    });
  }
  if (status === "RECOVERED") {
    explanations.push({
      code: "ALL_VISITS_RECOVERED",
      message: `${recoveredCount} affected visit${recoveredCount === 1 ? " has" : "s have"} a legal replacement.`,
      count: recoveredCount,
    });
  } else if (status === "PARTIAL") {
    explanations.push({
      code: "PARTIAL_RECOVERY",
      message: `${recoveredCount} visit${recoveredCount === 1 ? " has" : "s have"} a replacement; ${unresolvedCount} still require manual handling.`,
      count: unresolvedCount,
    });
  } else if (status === "BLOCKED") {
    explanations.push({
      code: "RECOVERY_BLOCKED",
      message: `${unresolvedCount} affected visit${unresolvedCount === 1 ? " requires" : "s require"} manual handling.`,
      count: unresolvedCount,
    });
  }
  return explanations;
}

function emptyResult(explanation: RecoveryExplanation): ScheduleRecoveryResult {
  return {
    status: "NO_IMPACT",
    affected_count: 0,
    recovered_count: 0,
    locked_preserved_count: 0,
    unresolved_count: 0,
    appointments: [],
    explanations: [explanation],
  };
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}
