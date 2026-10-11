/**
 * Candidate generation (spec sections 29-30).
 *
 * Produces the set of appointments that COULD legally exist before plan search
 * decides which of them should. The deterministic bounded patient-week
 * optimizer consumes `CandidateAppointment[]` today; the same intermediate
 * model remains compatible with a future CP-SAT service.
 *
 * Two things matter for every optimizer:
 *
 *  1. Candidates that violate an obvious hard rule are rejected HERE, not in
 *     plan search. A model given impossible intervals is slower and its
 *     infeasibility is harder to explain.
 *  2. The rejection tally is kept. Section 67 requires "no eligible RBT
 *     available Wednesday 3-5" rather than "no solution", and the counts of
 *     what was rejected and why are the raw material for that.
 */

import { SLOT_MINUTES, SlotRange, minutesToSlots, slotsToHours } from "../domain/slots";
import type {
  Appointment,
  CandidateAppointment,
  SchedulingFlexibility,
  UUID,
} from "../domain/types";
import { ScheduleContext } from "../rules/context";
import { ProposedBooking, evaluateBooking } from "../rules/engine";
import type { TravelModel } from "../rules/travel";
import type { ViolationCode } from "../rules/violations";

export interface CandidateOptions {
  patient_id: UUID;
  /** Services to generate for. Defaults to every service the patient needs. */
  service_ids?: UUID[];
  /** The service being optimized, if any — marks candidates as `target_service`. */
  target_service_id?: UUID;
  /** Durations to try, in minutes. Defaults to the service's configured set. */
  durations?: number[];
  /**
   * Slot granularity for start times. 1 = every 15 minutes. Raising this to 2
   * or 4 cuts the candidate count sharply on wide-open weeks at the cost of
   * only considering starts on the half or full hour.
   */
  startStepSlots?: number;
  /** Include existing appointments as candidates. Locked ones are mandatory. */
  includeExisting?: boolean;
  /** Safety valve. Generation stops here and reports `truncated`. */
  maxCandidates?: number;
  /** Earliest slot to enumerate. Applied before the candidate safety valve. */
  minimumStartSlot?: number;
  travel?: TravelModel;
}

export interface CandidateResult {
  candidates: CandidateAppointment[];
  /** How many proposals were generated and thrown away. */
  rejected: number;
  /** Rejections by first hard-violation code — feeds section 67 explanations. */
  rejectionsByCode: Partial<Record<ViolationCode, number>>;
  /** True when generation hit `maxCandidates` and stopped early. */
  truncated: boolean;
  generated_ms: number;
}

const DEFAULT_MAX_CANDIDATES = 20_000;

export function generateCandidates(
  ctx: ScheduleContext,
  options: CandidateOptions,
): CandidateResult {
  const started = Date.now();
  const step = Math.max(1, options.startStepSlots ?? 1);
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const minimumStartSlot = Math.max(0, Math.min(
    ctx.grid.totalSlots,
    Math.ceil(options.minimumStartSlot ?? 0),
  ));
  const includeExisting = options.includeExisting ?? true;

  const candidates: CandidateAppointment[] = [];
  const rejectionsByCode: Partial<Record<ViolationCode, number>> = {};
  let rejected = 0;
  let truncated = false;

  const incumbentProvidersByService = new Map<UUID, Set<UUID>>();
  for (const appointment of ctx.appointmentsByPatient.get(options.patient_id) ?? []) {
    if (!appointment.provider_id) continue;
    let providers = incumbentProvidersByService.get(appointment.service_id);
    if (!providers) {
      providers = new Set<UUID>();
      incumbentProvidersByService.set(appointment.service_id, providers);
    }
    providers.add(appointment.provider_id);
  }
  const preferences = ctx.patientPreferences.get(options.patient_id) ?? [];
  const objectiveFlags = (serviceId: UUID, providerId: UUID) => ({
    continuity: incumbentProvidersByService.get(serviceId)?.has(providerId) ?? false,
    preferred: preferences.some(
      (preference) =>
        (!preference.preferred_service_id || preference.preferred_service_id === serviceId) &&
        preference.preferred_provider_id === providerId,
    ),
  });
  const resourceChoiceCache = new Map<string, UUID[][]>();

  const serviceIds = [...(options.service_ids ?? defaultServiceIds(ctx, options.patient_id))].sort(
    (a, b) => a.localeCompare(b),
  );

  // Existing appointments for the services being generated come first: the
  // plan search needs them as candidates so it can decide to keep, move or
  // drop them, and locked ones must be present or the model can schedule over
  // them.
  //
  // Appointments for OTHER services are deliberately left out. They are not
  // up for negotiation in this run, and they already constrain it through the
  // rule engine, which sees them in the context regardless.
  if (includeExisting) {
    const inScope = new Set(serviceIds);
    for (const appointment of ctx.appointmentsByPatient.get(options.patient_id) ?? []) {
      if (!appointment.provider_id) continue;
      if (!inScope.has(appointment.service_id)) continue;
      candidates.push(
        toCandidate(ctx, {
          id: `existing:${appointment.id}`,
          patient_id: appointment.patient_id,
          service_id: appointment.service_id,
          provider_id: appointment.provider_id,
          authorization_id: appointment.authorization_id,
          location_id: appointment.location_id,
          resource_ids: appointment.resource_ids,
          range: appointment.range,
          is_existing: true,
          flexibility: appointment.scheduling_flexibility,
          target_service_id: options.target_service_id,
          ...objectiveFlags(appointment.service_id, appointment.provider_id),
        }),
      );
    }
  }

  // Only appointments that are actually in this optimization and allowed to
  // move may be ignored while generating replacement candidates. The previous
  // implementation ignored *every* patient appointment, which let a
  // single-service run propose time on top of locked or out-of-scope care.
  const inScope = new Set(serviceIds);
  const existingIds = new Set(
    includeExisting
      ? (ctx.appointmentsByPatient.get(options.patient_id) ?? [])
          .filter(
            (appointment) =>
              inScope.has(appointment.service_id) &&
              appointment.scheduling_flexibility !== "LOCKED",
          )
          .map((appointment) => appointment.id)
      : [],
  );

  outer: for (const serviceId of serviceIds) {
    const service = ctx.services.get(serviceId);
    if (!service || !service.active) continue;

    const durations = [...(
      options.durations ??
      ctx.serviceDurations.get(serviceId) ??
      [service.default_duration_minutes]
    )].sort((a, b) => a - b);

    const authorizations = service.requires_authorization
      ? ctx.authorizationsFor(options.patient_id, serviceId).filter((a) => a.status === "ACTIVE")
      : [null];
    if (authorizations.length === 0) continue; // nothing to bill against

    for (const provider of ctx.eligibleProviders(serviceId)) {
      const windows = ctx
        .meetingWindows(options.patient_id, provider.id, serviceId)
        .sort((a, b) => a.startSlot - b.startSlot || a.endSlot - b.endSlot);
      if (windows.length === 0) continue;

      for (const authorization of authorizations) {
        for (const durationMinutes of durations) {
          const durationSlots = minutesToSlots(durationMinutes);

          for (const window of windows) {
            const firstStart = window.startSlot + Math.ceil(
              Math.max(0, minimumStartSlot - window.startSlot) / step,
            ) * step;
            for (
              let startSlot = firstStart;
              startSlot + durationSlots <= window.endSlot;
              startSlot += step
            ) {
              const range: SlotRange = {
                startSlot,
                endSlot: startSlot + durationSlots,
              };

              for (const locationId of ctx.providerLocationsForRange(provider.id, range)) {
                const resourceKey = `${serviceId}:${locationId ?? "no-location"}`;
                let resourceChoices = resourceChoiceCache.get(resourceKey);
                if (!resourceChoices) {
                  resourceChoices = resourceChoicesFor(ctx, serviceId, locationId, false);
                  resourceChoiceCache.set(resourceKey, resourceChoices);
                }
                for (const resourceIds of resourceChoices) {
                const proposal: ProposedBooking = {
                patient_id: options.patient_id,
                service_id: serviceId,
                provider_id: provider.id,
                location_id: locationId,
                authorization_id: authorization?.id ?? null,
                resource_ids: resourceIds,
                range,
                telehealth: false,
                };

                const { valid, violations } = evaluateBooking(proposal, ctx, {
                travel: options.travel,
                includeSoft: false,
                // Existing appointments are candidates in their own right, so
                // a new candidate is allowed to occupy their time — plan
                // search decides which of the two survives.
                ignoreAppointmentIds: existingIds,
                stopAfterFirstHard: true,
                });

                if (!valid) {
                  rejected += 1;
                  const code = violations.find((v) => v.severity === "HARD")?.code;
                  if (code) rejectionsByCode[code] = (rejectionsByCode[code] ?? 0) + 1;
                  continue;
                }

                candidates.push(
                  toCandidate(ctx, {
                  id: [
                    "new",
                    serviceId,
                    provider.id,
                    authorization?.id ?? "no-auth",
                    locationId ?? "no-location",
                    [...resourceIds].sort().join(",") || "no-resource",
                    startSlot,
                    durationSlots,
                  ].join(":"),
                  patient_id: options.patient_id,
                  service_id: serviceId,
                  provider_id: provider.id,
                  authorization_id: authorization?.id ?? null,
                  location_id: locationId,
                  resource_ids: resourceIds,
                  range,
                  is_existing: false,
                  flexibility: "FLEXIBLE",
                  target_service_id: options.target_service_id,
                  ...objectiveFlags(serviceId, provider.id),
                  }),
                );

                if (candidates.length >= maxCandidates) {
                  truncated = true;
                  break outer;
                }
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    candidates,
    rejected,
    rejectionsByCode,
    truncated,
    generated_ms: Date.now() - started,
  };
}

/** Services the patient has a requirement or an active authorization for. */
function defaultServiceIds(ctx: ScheduleContext, patientId: UUID): UUID[] {
  const ids = new Set<UUID>();
  for (const requirement of ctx.patientServiceRequirements.get(patientId) ?? []) {
    ids.add(requirement.service_id);
  }
  for (const authorization of ctx.authorizations.get(patientId) ?? []) {
    if (authorization.status === "ACTIVE") ids.add(authorization.service_id);
  }
  return [...ids];
}

/** Return every legal one-of room/resource choice at the selected location. */
export function resourceChoicesFor(
  ctx: ScheduleContext,
  serviceId: UUID,
  locationId: UUID | null,
  telehealth = false,
): UUID[][] {
  if (telehealth) return [[]];
  const required = (ctx.serviceResources.get(serviceId) ?? []).filter((r) => r.required);
  if (required.length === 0) return [[]];

  const atLocation = required.filter((link) => {
    const resource = ctx.resources.get(link.resource_id);
    return (
      resource?.active &&
      (!locationId || resource.location_id === null || resource.location_id === locationId)
    );
  });
  // Preserve one invalid option so the rule engine can explain a missing
  // resource instead of silently producing no candidates.
  return atLocation.length > 0
    ? atLocation
        .sort((a, b) => a.resource_id.localeCompare(b.resource_id))
        .map((link) => [link.resource_id])
    : [[]];
}

function toCandidate(
  ctx: ScheduleContext,
  input: {
    id: string;
    patient_id: UUID;
    service_id: UUID;
    provider_id: UUID;
    authorization_id: UUID | null;
    location_id: UUID | null;
    resource_ids: UUID[];
    range: SlotRange;
    is_existing: boolean;
    flexibility: SchedulingFlexibility;
    target_service_id?: UUID;
    continuity: boolean;
    preferred: boolean;
  },
): CandidateAppointment {
  const requirement = ctx.requirementFor(input.patient_id, input.service_id);
  const durationSlots = input.range.endSlot - input.range.startSlot;

  // Values the objective functions will read. Kept as plain numbers so the
  // plan search never has to look anything up again.
  return {
    candidate_id: input.id,
    patient_id: input.patient_id,
    service_id: input.service_id,
    provider_id: input.provider_id,
    authorization_id: input.authorization_id,
    start_slot: input.range.startSlot,
    duration_slots: durationSlots,
    end_slot: input.range.endSlot,
    location_id: input.location_id,
    resource_ids: input.resource_ids,
    is_existing: input.is_existing,
    flexibility: input.flexibility,
    service_priority: requirement?.priority ?? 100,
    required_service: requirement?.required ?? false,
    target_service: input.target_service_id === input.service_id,
    objective_values: {
      duration_slots: durationSlots,
      hours: slotsToHours(durationSlots),
      continuity: input.continuity ? 1 : 0,
      preferred_provider: input.preferred ? 1 : 0,
      is_existing: input.is_existing ? 1 : 0,
      minutes: durationSlots * SLOT_MINUTES,
    },
  };
}

/**
 * Turn a candidate back into an appointment row, for provisional placement in
 * an in-memory snapshot.
 *
 * Status is SCHEDULED rather than PROPOSED on purpose: only the occupying
 * statuses take up time on the grid, and a provisionally placed appointment
 * has to block the slot it sits in or the next placement will be allowed to
 * overlap it. These rows exist only inside a cloned context and are never
 * persisted — nothing here writes.
 */
export function candidateToAppointment(
  candidate: CandidateAppointment,
  ctx: ScheduleContext,
): Appointment {
  return {
    id: candidate.candidate_id,
    patient_id: candidate.patient_id,
    service_id: candidate.service_id,
    provider_id: candidate.provider_id,
    authorization_id: candidate.authorization_id,
    location_id: candidate.location_id,
    start_time: ctx.grid.instantOf(candidate.start_slot).toISOString(),
    end_time: ctx.grid.instantOf(candidate.end_slot).toISOString(),
    status: "SCHEDULED",
    scheduling_flexibility: candidate.flexibility,
    telehealth: false,
    original_start_time: null,
    original_provider_id: null,
    original_location_id: null,
  };
}
