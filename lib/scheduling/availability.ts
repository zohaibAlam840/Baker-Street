/**
 * Availability search (spec section 49).
 *
 * Walks every eligible provider's free windows, proves each start time against
 * the rule engine, and ranks the survivors. No solver involved: this answers
 * "when could this happen?", not "what is the best whole-week schedule?".
 *
 * The same enumeration is what candidate generation (spec sections 29-30) will
 * reuse in Phase 2, with the ranking dropped and the results handed to CP-SAT.
 */

import { SLOTS_PER_DAY, SLOT_MINUTES, SlotRange, minutesToSlots } from "../domain/slots";
import { formatDateOnly } from "../domain/time";
import type { UUID } from "../domain/types";
import { ScheduleContext } from "../rules/context";
import { ProposedBooking, evaluateBooking } from "../rules/engine";
import type { TravelModel } from "../rules/travel";
import type { Violation } from "../rules/violations";

export interface AvailabilityQuery {
  patient_id: UUID;
  service_id: UUID;
  /** Defaults to the service's default duration. */
  duration_minutes?: number;
  /** Restrict to one provider; otherwise every eligible provider is tried. */
  provider_id?: UUID;
  location_id?: UUID;
  telehealth?: boolean;
  /** Authorization to bill against; auto-selected when the service needs one. */
  authorization_id?: UUID;
  max_results?: number;
  travel?: TravelModel;
  /**
   * Restrict returned slots to this part of the horizon. The horizon itself
   * still has to span a whole week so weekly authorization and frequency
   * totals are computed against every appointment in the week, not just the
   * days the caller asked about.
   */
  window?: SlotRange;
}

export interface ScoreComponent {
  label: string;
  points: number;
}

export interface AvailableSlot {
  start: string; // ISO instant
  end: string;
  date: string; // YYYY-MM-DD, local
  range: SlotRange;
  provider_id: UUID;
  provider_name: string;
  location_id: UUID | null;
  duration_minutes: number;
  score: number;
  /** Why it scored what it scored, so the UI can justify the ordering. */
  score_breakdown: ScoreComponent[];
  /** Soft misses — the slot is bookable, but these are the trade-offs. */
  notes: Violation[];
}

/** Weightings for the ranking. Tunable without touching the enumeration. */
const WEIGHTS = {
  preferredProvider: 25,
  continuity: 20,
  preferredLocation: 10,
  adjacentToExisting: 15,
  preferredWindow: 10,
  softMissPenalty: -8,
  fragmentationPenalty: -12,
};

export function findAvailability(
  query: AvailabilityQuery,
  ctx: ScheduleContext,
): AvailableSlot[] {
  const service = ctx.services.get(query.service_id);
  if (!service) return [];

  const durationMinutes = query.duration_minutes ?? service.default_duration_minutes;
  const durationSlots = minutesToSlots(durationMinutes);
  if (durationSlots <= 0) return [];

  const providers = query.provider_id
    ? [ctx.providers.get(query.provider_id)].filter((p) => p != null)
    : ctx.eligibleProviders(query.service_id);

  const preferences = ctx.patientPreferences.get(query.patient_id) ?? [];
  const preferredProviderIds = new Set(
    preferences
      .filter((p) => !p.preferred_service_id || p.preferred_service_id === query.service_id)
      .map((p) => p.preferred_provider_id)
      .filter((id): id is UUID => id != null),
  );
  const preferredLocationIds = new Set(
    preferences
      .map((p) => p.preferred_location_id)
      .filter((id): id is UUID => id != null),
  );

  // Providers this patient already sees for this service — continuity is an
  // explicit objective (spec section 7, level 6), so it shapes the ranking.
  const incumbentProviderIds = new Set(
    (ctx.appointmentsByPatient.get(query.patient_id) ?? [])
      .filter((a) => a.service_id === query.service_id && a.provider_id)
      .map((a) => a.provider_id as UUID),
  );

  const authorizationId =
    query.authorization_id ??
    (service.requires_authorization
      ? (ctx.authorizationsFor(query.patient_id, query.service_id).find(
          (a) => a.status === "ACTIVE",
        )?.id ?? null)
      : null);

  const results: AvailableSlot[] = [];

  for (const provider of providers) {
    const windows = ctx.meetingWindows(query.patient_id, provider.id, query.service_id);
    const preferredWindows = ctx.providerPreferredWindows(provider.id);
    const locationId = query.location_id ?? resolveLocation(ctx, provider.id, query);

    for (const window of windows) {
      const from = Math.max(window.startSlot, query.window?.startSlot ?? 0);
      const until = Math.min(window.endSlot, query.window?.endSlot ?? ctx.grid.totalSlots);

      for (let startSlot = from; startSlot + durationSlots <= until; startSlot += 1) {
        const range = { startSlot, endSlot: startSlot + durationSlots };

        const proposal: ProposedBooking = {
          patient_id: query.patient_id,
          service_id: query.service_id,
          provider_id: provider.id,
          location_id: locationId,
          authorization_id: authorizationId,
          resource_ids: resolveResources(ctx, query.service_id, locationId, query.telehealth),
          range,
          telehealth: query.telehealth ?? false,
        };

        const { valid, violations } = evaluateBooking(proposal, ctx, {
          travel: query.travel,
          includeSoft: true,
        });
        if (!valid) continue;

        const notes = violations.filter((v) => v.severity === "SOFT");
        const breakdown: ScoreComponent[] = [];

        if (preferredProviderIds.has(provider.id)) {
          breakdown.push({ label: "Preferred provider", points: WEIGHTS.preferredProvider });
        }
        if (incumbentProviderIds.has(provider.id)) {
          breakdown.push({ label: "Provider continuity", points: WEIGHTS.continuity });
        }
        if (locationId && preferredLocationIds.has(locationId)) {
          breakdown.push({ label: "Preferred location", points: WEIGHTS.preferredLocation });
        }
        if (coveredBy(range, preferredWindows)) {
          breakdown.push({ label: "Provider's preferred hours", points: WEIGHTS.preferredWindow });
        }

        const adjacency = adjacencyScore(ctx, query.patient_id, range);
        if (adjacency !== 0) {
          breakdown.push({
            label: adjacency > 0 ? "Adjacent to existing appointment" : "Creates a gap in the day",
            points: adjacency,
          });
        }
        if (notes.length > 0) {
          breakdown.push({
            label: `${notes.length} preference miss${notes.length === 1 ? "" : "es"}`,
            points: notes.length * WEIGHTS.softMissPenalty,
          });
        }

        const score = breakdown.reduce((total, part) => total + part.points, 0);
        const startInstant = ctx.grid.instantOf(range.startSlot);

        results.push({
          start: startInstant.toISOString(),
          end: ctx.grid.instantOf(range.endSlot).toISOString(),
          date: formatDateOnly(startInstant, ctx.grid.timeZone),
          range,
          provider_id: provider.id,
          provider_name: `${provider.first_name} ${provider.last_name}`,
          location_id: locationId,
          duration_minutes: durationMinutes,
          score,
          score_breakdown: breakdown,
          notes,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
  return results.slice(0, query.max_results ?? 20);
}

/**
 * Adjacency: butting a new appointment against an existing one keeps the
 * patient's day contiguous, which is objective level 8. A slot that leaves a
 * short orphan gap is penalised.
 */
function adjacencyScore(ctx: ScheduleContext, patientId: UUID, range: SlotRange): number {
  const sameDay = (ctx.appointmentsByPatient.get(patientId) ?? []).filter(
    (a) =>
      Math.floor(a.range.startSlot / SLOTS_PER_DAY) ===
      Math.floor(range.startSlot / SLOTS_PER_DAY),
  );
  if (sameDay.length === 0) return 0;

  let best = 0;
  for (const appointment of sameDay) {
    if (
      appointment.range.endSlot === range.startSlot ||
      appointment.range.startSlot === range.endSlot
    ) {
      return WEIGHTS.adjacentToExisting;
    }
    const gap =
      appointment.range.startSlot >= range.endSlot
        ? appointment.range.startSlot - range.endSlot
        : range.startSlot - appointment.range.endSlot;
    // A gap under an hour is dead time nobody can use.
    if (gap > 0 && gap * SLOT_MINUTES < 60) best = WEIGHTS.fragmentationPenalty;
  }
  return best;
}

function coveredBy(range: SlotRange, windows: SlotRange[]): boolean {
  return windows.some(
    (w) => w.startSlot <= range.startSlot && range.endSlot <= w.endSlot,
  );
}

/** Where the service would happen: explicit choice, else the provider's base. */
function resolveLocation(
  ctx: ScheduleContext,
  providerId: UUID,
  query: AvailabilityQuery,
): UUID | null {
  if (query.telehealth) {
    const telehealth = [...ctx.locations.values()].find((l) => l.type === "TELEHEALTH");
    return telehealth?.id ?? null;
  }
  return ctx.providers.get(providerId)?.home_location_id ?? null;
}

/** Attach the first required resource available at the chosen location. */
function resolveResources(
  ctx: ScheduleContext,
  serviceId: UUID,
  locationId: UUID | null,
  telehealth?: boolean,
): UUID[] {
  if (telehealth) return [];
  const required = (ctx.serviceResources.get(serviceId) ?? []).filter((r) => r.required);
  if (required.length === 0) return [];

  const atLocation = required.find((link) => {
    const resource = ctx.resources.get(link.resource_id);
    return resource?.active && (!locationId || resource.location_id === locationId);
  });
  return atLocation ? [atLocation.resource_id] : [required[0].resource_id];
}
