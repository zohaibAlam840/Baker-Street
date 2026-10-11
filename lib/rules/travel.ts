/**
 * Travel time between locations (spec section 40).
 *
 * Travel can be a hard constraint or a scoring penalty depending on
 * configuration. The current build ships a deliberately crude default so the rule exists
 * and is tested; swapping in a real distance matrix later means replacing
 * `TravelModel` and nothing else.
 */

import type { Location, UUID } from "../domain/types";

export interface TravelModel {
  /** Minutes needed to get from one location to another. */
  minutesBetween(fromLocationId: UUID | null, toLocationId: UUID | null): number;
  /** Whether insufficient travel time invalidates a schedule or only costs it. */
  enforceAsHardConstraint: boolean;
}

export interface FlatTravelOptions {
  /** Applied between any two distinct physical locations. */
  defaultMinutes?: number;
  /** Overrides keyed "fromId>toId". */
  overrides?: Record<string, number>;
  enforceAsHardConstraint?: boolean;
}

/**
 * Flat-rate model: zero within a location, zero when either end is telehealth,
 * a fixed default between any two distinct locations, with explicit overrides
 * for known pairs.
 */
export class FlatTravelModel implements TravelModel {
  readonly enforceAsHardConstraint: boolean;
  private readonly defaultMinutes: number;
  private readonly overrides: Record<string, number>;
  private readonly locations: Map<UUID, Location>;

  constructor(locations: Map<UUID, Location>, options: FlatTravelOptions = {}) {
    this.locations = locations;
    this.defaultMinutes = options.defaultMinutes ?? 30;
    this.overrides = options.overrides ?? {};
    this.enforceAsHardConstraint = options.enforceAsHardConstraint ?? true;
  }

  minutesBetween(fromLocationId: UUID | null, toLocationId: UUID | null): number {
    if (!fromLocationId || !toLocationId) return 0;
    if (fromLocationId === toLocationId) return 0;

    // Telehealth is not a place you travel to.
    if (
      this.locations.get(fromLocationId)?.type === "TELEHEALTH" ||
      this.locations.get(toLocationId)?.type === "TELEHEALTH"
    ) {
      return 0;
    }

    return (
      this.overrides[`${fromLocationId}>${toLocationId}`] ??
      this.overrides[`${toLocationId}>${fromLocationId}`] ??
      this.defaultMinutes
    );
  }
}

/** Travel is ignored entirely — useful for single-clinic scenarios and tests. */
export const NO_TRAVEL: TravelModel = {
  minutesBetween: () => 0,
  enforceAsHardConstraint: false,
};
