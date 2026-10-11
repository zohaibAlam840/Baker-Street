/**
 * Constraint violations.
 *
 * Rules return structured violations rather than booleans. Spec section 67
 * requires the system to explain *why* a schedule is infeasible ("no eligible
 * RBT available Wednesday 3-5", "remaining authorization = 3 hours"), and that
 * is only possible if every rejection carries its reasons forward.
 */

import type { SlotRange } from "../domain/slots";
import type { UUID } from "../domain/types";

export type ViolationCode =
  // Overlaps
  | "PATIENT_OVERLAP"
  | "PROVIDER_OVERLAP"
  | "RESOURCE_OVERLAP"
  // Eligibility
  | "PROVIDER_NOT_ELIGIBLE"
  | "PROVIDER_CREDENTIAL_INVALID"
  | "PROVIDER_CREDENTIAL_EXPIRED"
  // Availability
  | "PATIENT_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "PATIENT_RESTRICTED"
  // Authorization
  | "AUTHORIZATION_MISSING"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_EXCEEDED"
  | "AUTHORIZATION_SERVICE_MISMATCH"
  // Service configuration
  | "SERVICE_INACTIVE"
  | "SERVICE_DURATION_INVALID"
  | "SERVICE_MODALITY_NOT_ALLOWED"
  | "REQUIRED_RESOURCE_MISSING"
  | "RESOURCE_WRONG_LOCATION"
  // Entity state
  | "PATIENT_INACTIVE"
  | "PROVIDER_INACTIVE"
  | "APPOINTMENT_LOCKED"
  // Time
  | "TRAVEL_TIME_INSUFFICIENT"
  | "OUTSIDE_HORIZON"
  | "LOCAL_TIME_INVALID"
  // Preferences designated hard
  | "HARD_PREFERENCE_VIOLATED";

/**
 * HARD makes a schedule invalid (spec section 6). SOFT only ranks it — soft
 * results are carried so the availability endpoint can explain why a slot is
 * offered but poorly rated.
 */
export type ViolationSeverity = "HARD" | "SOFT";

export interface Violation {
  code: ViolationCode;
  severity: ViolationSeverity;
  /** Human-readable, safe to surface in the UI. */
  message: string;
  /** The conflicting appointment, when there is one. */
  appointment_id?: UUID;
  patient_id?: UUID;
  provider_id?: UUID;
  resource_id?: UUID;
  service_id?: UUID;
  authorization_id?: UUID;
  /** The slot window the violation applies to. */
  range?: SlotRange;
  /** Free-form numbers the explanation layer can quote back. */
  detail?: Record<string, string | number | boolean | null>;
}

export function hard(
  code: ViolationCode,
  message: string,
  extra: Omit<Violation, "code" | "severity" | "message"> = {},
): Violation {
  return { code, severity: "HARD", message, ...extra };
}

export function soft(
  code: ViolationCode,
  message: string,
  extra: Omit<Violation, "code" | "severity" | "message"> = {},
): Violation {
  return { code, severity: "SOFT", message, ...extra };
}

export function hasHardViolation(violations: readonly Violation[]): boolean {
  return violations.some((v) => v.severity === "HARD");
}

export function hardViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter((v) => v.severity === "HARD");
}
