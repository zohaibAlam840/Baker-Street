/**
 * What-if and hiring simulation (spec sections 50 and 52).
 *
 * "What happens if Baker Street hires three more RBTs?" is answered by cloning
 * the week in memory, adding hypothetical clinicians, and recomputing. The
 * spec is explicit that this must never touch production data — so nothing
 * here writes, and the scenario exists only for the length of one request.
 *
 * The figure it produces is *schedulable* capacity, not just extra hours on a
 * roster. Three new RBTs only help if their hours land where patients are
 * actually free and authorization remains, which is exactly the distinction
 * section 51 insists on.
 */

import { SlotRange, intersectAll, mergeRanges, slotsToHours, subtractRanges } from "../domain/slots";
import type { Provider, ProviderAvailability, ProviderType, UUID } from "../domain/types";
import { ScheduleContext } from "../rules/context";

export interface HiringScenario {
  /** What kind of clinician to add. */
  providerType: ProviderType;
  /** How many. */
  count: number;
  /** Which service they would deliver. */
  serviceId: UUID;
  /** Clinical hours each, per weekday. */
  shift?: { start: string; end: string; days: number[] };
  /** Where they would be based. */
  locationId?: UUID | null;
}

export interface ScenarioResult {
  label: string;

  /** Hours patients could actually receive, before and after. */
  schedulable_hours_now: number;
  schedulable_hours_after: number;
  additional_schedulable_hours: number;

  /** Raw clinical hours the new staff bring, before demand is considered. */
  added_clinical_hours: number;
  /** Hours the new staff would bring that nobody can use. */
  wasted_hours: number;

  /** Authorization position is unchanged by hiring — shown to make that plain. */
  unused_authorization: number;
  /** Authorized hours that remain unstaffable even after the hire. */
  still_unfillable: number;

  patients_helped: number;
  notes: string[];
}

/**
 * Hours that could be delivered to patients right now: for each patient, the
 * time they are free and at least one eligible, credentialled clinician is
 * also free, capped by what their authorization still allows.
 */
function schedulableHours(ctx: ScheduleContext): { total: number; byPatient: Map<UUID, number> } {
  const byPatient = new Map<UUID, number>();
  let total = 0;

  for (const patient of ctx.patients.values()) {
    if (patient.status !== "ACTIVE") continue;

    let patientTotal = 0;

    for (const requirement of ctx.patientServiceRequirements.get(patient.id) ?? []) {
      const serviceId = requirement.service_id;

      // Ceiling: what is still allowed for this patient and service.
      const scheduled = slotsToHours(ctx.slotsScheduled(patient.id, serviceId));
      const authorization = ctx
        .authorizationsFor(patient.id, serviceId)
        .find((a) => a.status === "ACTIVE");

      const ceilings: number[] = [];
      if (authorization?.authorized_hours != null) {
        ceilings.push(Math.max(0, authorization.authorized_hours - scheduled));
      }
      if (requirement.target_hours_per_week != null) {
        ceilings.push(Math.max(0, requirement.target_hours_per_week - scheduled));
      }
      if (ceilings.length === 0) continue;
      const allowed = Math.min(...ceilings);
      if (allowed <= 0) continue;

      // Supply: patient free time that some eligible clinician can cover.
      const patientBusy = (ctx.appointmentsByPatient.get(patient.id) ?? []).map((a) => a.range);
      const patientFree = subtractRanges(
        ctx.patientAvailableWindows(patient.id, serviceId),
        patientBusy,
      );
      if (patientFree.length === 0) continue;

      const providerFree: SlotRange[] = [];
      for (const provider of ctx.eligibleProviders(serviceId)) {
        const busy = (ctx.appointmentsByProvider.get(provider.id) ?? []).map((a) => a.range);
        providerFree.push(...subtractRanges(ctx.providerClinicalWindows(provider.id), busy));
      }
      if (providerFree.length === 0) continue;

      const overlap = intersectAll(patientFree, mergeRanges(providerFree));
      const overlapHours = overlap.reduce(
        (sum, w) => sum + slotsToHours(w.endSlot - w.startSlot),
        0,
      );

      patientTotal += Math.min(allowed, overlapHours);
    }

    if (patientTotal > 0) {
      byPatient.set(patient.id, patientTotal);
      total += patientTotal;
    }
  }

  return { total: Math.round(total * 100) / 100, byPatient };
}

/** Authorization that is funded, unscheduled, and not coverable by anyone. */
function authorizationPosition(ctx: ScheduleContext): {
  unused: number;
} {
  let authorized = 0;
  let used = 0;
  for (const list of ctx.authorizations.values()) {
    for (const authorization of list) {
      if (authorization.status !== "ACTIVE" || authorization.authorized_hours == null) continue;
      authorized += authorization.authorized_hours;
      used += slotsToHours(ctx.slotsUsedAgainstAuthorization(authorization.id));
    }
  }
  return { unused: Math.round(Math.max(0, authorized - used) * 100) / 100 };
}

/**
 * The default shift is afternoon-and-Saturday, not nine-to-five.
 *
 * Paediatric caseloads are free after school, so a hypothetical clinician on a
 * 09:00-17:00 shift contributes almost nothing — most of their hours land
 * while the patients are in class. Defaulting to the shift a practice would
 * actually hire for keeps the simulation from answering a question nobody
 * asked; the shift is configurable for exactly this reason.
 */
const DEFAULT_SHIFT = { start: "12:00", end: "20:00", days: [1, 2, 3, 4, 5, 6] };

export function simulateHiring(
  ctx: ScheduleContext,
  scenario: HiringScenario,
): ScenarioResult {
  const shift = scenario.shift ?? DEFAULT_SHIFT;

  const before = schedulableHours(ctx);
  const position = authorizationPosition(ctx);

  // Build the hypothetical clinicians. They exist only in this clone.
  const providers: Provider[] = [];
  const availability: ProviderAvailability[] = [];
  const services: SnapshotServiceLink[] = [];
  const credentials: SnapshotCredential[] = [];

  const locationId =
    scenario.locationId ??
    [...ctx.locations.values()].find((l) => l.type === "CLINIC")?.id ??
    null;

  for (let i = 0; i < scenario.count; i += 1) {
    const id = `hypothetical-${scenario.providerType}-${i}`;
    providers.push({
      id,
      external_id: null,
      first_name: "New",
      last_name: `${scenario.providerType} ${i + 1}`,
      provider_type: scenario.providerType,
      status: "ACTIVE",
      timezone: ctx.grid.timeZone,
      home_location_id: locationId,
    });
    credentials.push({
      id: `cred-${id}`,
      provider_id: id,
      credential_type: scenario.providerType,
      credential_number: null,
      state: null,
      issue_date: null,
      expiration_date: null,
      status: "ACTIVE",
    });
    services.push({
      id: `ps-${id}`,
      provider_id: id,
      service_id: scenario.serviceId,
      eligible: true,
      effective_start: null,
      effective_end: null,
    });
    for (const day of shift.days) {
      availability.push({
        id: `prav-${id}-${day}`,
        provider_id: id,
        day_of_week: day as ProviderAvailability["day_of_week"],
        start_time: shift.start,
        end_time: shift.end,
        availability_type: "CLINICAL",
        location_id: locationId,
        effective_start: null,
        effective_end: null,
      });
    }
  }

  const after = new ScheduleContext(ctx.grid, {
    ...ctx.rows,
    providers: [...ctx.rows.providers, ...providers],
    providerCredentials: [...ctx.rows.providerCredentials, ...credentials],
    providerServices: [...ctx.rows.providerServices, ...services],
    providerAvailability: [...ctx.rows.providerAvailability, ...availability],
  });

  const afterHours = schedulableHours(after);

  const addedClinicalHours = providers.reduce(
    (total, provider) =>
      total +
      after
        .providerClinicalWindows(provider.id)
        .reduce((sum, w) => sum + slotsToHours(w.endSlot - w.startSlot), 0),
    0,
  );

  const gained = Math.round((afterHours.total - before.total) * 100) / 100;
  const wasted = Math.round(Math.max(0, addedClinicalHours - gained) * 100) / 100;

  const helped = [...afterHours.byPatient].filter(
    ([patientId, hours]) => hours > (before.byPatient.get(patientId) ?? 0) + 0.001,
  ).length;

  const serviceName = ctx.services.get(scenario.serviceId)?.service_name ?? "the service";

  const notes: string[] = [];
  if (gained === 0) {
    notes.push(
      `Adding ${scenario.providerType}s changes nothing this week: the limit is not clinician time.`,
    );
  }
  if (wasted > 0 && gained > 0) {
    notes.push(
      `${wasted}h of the new clinical time falls where no patient is free or no authorization remains.`,
    );
  }
  if (gained >= addedClinicalHours - 0.001 && addedClinicalHours > 0) {
    notes.push("Every new hour could be used — demand exceeds supply for this service.");
  }
  notes.push(
    `Hiring does not change authorization: ${position.unused}h remain funded and unscheduled either way.`,
  );

  return {
    label: `${scenario.count} × ${scenario.providerType} for ${serviceName}`,
    schedulable_hours_now: before.total,
    schedulable_hours_after: afterHours.total,
    additional_schedulable_hours: gained,
    added_clinical_hours: Math.round(addedClinicalHours * 100) / 100,
    wasted_hours: wasted,
    unused_authorization: position.unused,
    still_unfillable: Math.round(Math.max(0, position.unused - afterHours.total) * 100) / 100,
    patients_helped: helped,
    notes,
  };
}

/** Capacity as it stands, with no change — the baseline every scenario moves from. */
export function currentCapacity(ctx: ScheduleContext) {
  const schedulable = schedulableHours(ctx);
  const position = authorizationPosition(ctx);
  return {
    schedulable_hours: schedulable.total,
    unused_authorization: position.unused,
    unfillable: Math.round(Math.max(0, position.unused - schedulable.total) * 100) / 100,
    patients_with_headroom: schedulable.byPatient.size,
  };
}

// Narrow structural types for the rows this module fabricates.
type SnapshotServiceLink = ScheduleContext["rows"]["providerServices"][number];
type SnapshotCredential = ScheduleContext["rows"]["providerCredentials"][number];
