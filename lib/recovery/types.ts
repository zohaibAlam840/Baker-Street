import type { SlotRange } from "../domain/slots";
import type { SchedulingFlexibility, UUID } from "../domain/types";
import type { TravelModel } from "../rules/travel";
import type { ViolationCode } from "../rules/violations";

/** One known appointment was disrupted (for example, by a patient call-in). */
export interface AppointmentRecoveryRequest {
  kind: "APPOINTMENT";
  appointment_id: UUID;
  /** Providers known to be unavailable for this recovery attempt. */
  excluded_provider_ids?: readonly UUID[];
}

/** Every future visit for a provider in this window needs to be recovered. */
export interface ProviderUnavailabilityRecoveryRequest {
  kind: "PROVIDER_UNAVAILABILITY";
  provider_id: UUID;
  unavailable_range: SlotRange;
}

export type ScheduleRecoveryRequest =
  | AppointmentRecoveryRequest
  | ProviderUnavailabilityRecoveryRequest;

export interface ScheduleRecoveryOptions {
  /** Number of legal choices retained for each affected appointment. */
  max_options_per_appointment?: number;
  /** Start-time granularity. One slot is 15 minutes. */
  start_step_slots?: number;
  /** Deterministic bound passed to candidate generation. */
  max_candidates_per_appointment?: number;
  travel?: TravelModel;
}

export type ScheduleRecoveryStatus = "RECOVERED" | "PARTIAL" | "BLOCKED" | "NO_IMPACT";

export type RecoveryExplanationCode =
  | "APPOINTMENT_NOT_FOUND"
  | "APPOINTMENT_NOT_RECOVERABLE"
  | "INVALID_UNAVAILABILITY_RANGE"
  | "NO_APPOINTMENTS_AFFECTED"
  | "LOCKED_VISIT_PRESERVED"
  | "SAME_TIME_PROVIDER_REPLACEMENT"
  | "NEARBY_SLOT"
  | "NO_LEGAL_ALTERNATIVE"
  | "ALL_VISITS_RECOVERED"
  | "PARTIAL_RECOVERY"
  | "RECOVERY_BLOCKED";

/**
 * Deliberately PHI-minimal. Messages never contain patient/provider names,
 * dates of birth, payer details, authorization numbers, notes, or contact data.
 */
export interface RecoveryExplanation {
  code: RecoveryExplanationCode;
  message: string;
  count?: number;
  limiting_rule?: ViolationCode;
}

/** A legal, fully re-proved replacement for one existing appointment. */
export interface RecoveryOption {
  id: string;
  provider_id: UUID;
  service_id: UUID;
  authorization_id: UUID | null;
  location_id: UUID | null;
  resource_ids: UUID[];
  start_slot: number;
  end_slot: number;
  start_time: string;
  end_time: string;
  telehealth: boolean;
  same_time: boolean;
  provider_changed: boolean;
  time_shift_minutes: number;
  explanations: RecoveryExplanation[];
}

export type RecoveryDisposition = "RECOVERED" | "LOCKED_PRESERVED" | "NO_ALTERNATIVE";

export interface AffectedAppointmentRecovery {
  appointment_id: UUID;
  service_id: UUID;
  flexibility: SchedulingFlexibility;
  disposition: RecoveryDisposition;
  original_start_slot: number;
  original_end_slot: number;
  recommended_option_id: string | null;
  /** The first option is the recommendation. Remaining options are fallbacks. */
  options: RecoveryOption[];
  explanations: RecoveryExplanation[];
}

export interface ScheduleRecoveryResult {
  status: ScheduleRecoveryStatus;
  affected_count: number;
  recovered_count: number;
  locked_preserved_count: number;
  unresolved_count: number;
  appointments: AffectedAppointmentRecovery[];
  explanations: RecoveryExplanation[];
}
