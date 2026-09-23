/**
 * Domain types mirroring the Phase 1 schema (supabase/schema.sql).
 *
 * These are plain data. Nothing here knows about Supabase, Next.js or React,
 * so the rule engine built on top stays portable to a Python solver service if
 * CP-SAT ends up living outside this repo.
 */

import type { Weekday } from "./time";

export type UUID = string;
/** "YYYY-MM-DD" */
export type DateOnly = string;
/** "HH:MM" or "HH:MM:SS" */
export type ClockTime = string;
/** ISO 8601 instant */
export type Timestamp = string;

export type PatientStatus = "ACTIVE" | "INACTIVE" | "PENDING" | "DISCHARGED";

export type ProviderType =
  | "RBT"
  | "BCBA"
  | "PSYCHOLOGIST"
  | "NEUROPSYCHOLOGIST"
  | "LMHC"
  | "LCSW"
  | "LPC"
  | "OT"
  | "PT"
  | "SLP"
  | "PODIATRIST"
  | "MD"
  | "DO"
  | "TECHNICIAN"
  | "OTHER";

export type ProviderStatus = "ACTIVE" | "INACTIVE" | "ON_LEAVE";
export type CredentialStatus = "ACTIVE" | "EXPIRED" | "SUSPENDED" | "PENDING";

export type ProviderAvailabilityType =
  | "CLINICAL"
  | "ADMINISTRATIVE"
  | "PREFERRED"
  | "HARD_UNAVAILABLE"
  | "PTO";

export type PatientAvailabilityType = "AVAILABLE" | "PREFERRED" | "HARD_UNAVAILABLE";

export type RestrictionType = "SCHOOL" | "WORK" | "OTHER_APPOINTMENT" | "HARD_UNAVAILABLE";

export type LocationType = "CLINIC" | "HOME" | "SCHOOL" | "COMMUNITY" | "TELEHEALTH";

export type AuthorizationStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "EXHAUSTED"
  | "PENDING"
  | "DENIED";

export type AppointmentStatus =
  | "SCHEDULED"
  | "CONFIRMED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "PROPOSED";

/** LOCKED cannot move at all; PROTECTED may move but at heavy cost (spec 38-39). */
export type SchedulingFlexibility = "LOCKED" | "PROTECTED" | "FLEXIBLE";

export type SolverStatus = "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIME_LIMIT" | "ERROR";

/** Spec section 41 — the generic objectives the engine exposes. */
export type OptimizationObjective =
  | "MAXIMIZE_SERVICE_HOURS"
  | "MAXIMIZE_SERVICE_SESSIONS"
  | "MAXIMIZE_AUTHORIZATION_UTILIZATION"
  | "COMPLETE_REQUIRED_SERVICES"
  | "MAXIMIZE_PROVIDER_UTILIZATION"
  | "MAXIMIZE_PROVIDER_CONTINUITY"
  | "MINIMIZE_APPOINTMENT_CHANGES"
  | "MINIMIZE_PATIENT_GAPS"
  | "MINIMIZE_PROVIDER_GAPS"
  | "MINIMIZE_TRAVEL"
  | "MAXIMIZE_PATIENT_PREFERENCES";

/** Spec section 42 — service behaviour as configuration, not solver branches. */
export interface OptimizationProfile {
  primary_objective?: OptimizationObjective;
  authorization_limit?: boolean;
  clinical_target?: boolean;
  continuity_weight?: number;
  preference_weight?: number;
}

export interface Location {
  id: UUID;
  name: string;
  type: LocationType;
  city: string | null;
  state: string | null;
  timezone: string;
  active: boolean;
}

export interface Patient {
  id: UUID;
  external_id: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: DateOnly | null;
  status: PatientStatus;
  timezone: string;
  primary_location_id: UUID | null;
}

export interface Service {
  id: UUID;
  service_code: string;
  service_name: string;
  department: string;
  active: boolean;
  default_duration_minutes: number;
  min_duration_minutes: number;
  max_duration_minutes: number;
  telehealth_allowed: boolean;
  in_person_allowed: boolean;
  group_allowed: boolean;
  requires_authorization: boolean;
  optimization_profile: OptimizationProfile;
}

export interface ServiceDuration {
  id: UUID;
  service_id: UUID;
  duration_minutes: number;
  active: boolean;
}

/**
 * Authorization and clinical need are separate concepts (spec section 9). A
 * patient may be authorized for 30h while the clinical floor is 20h, the
 * target 25h and the ceiling 30h; the optimizer needs all four.
 */
export interface PatientServiceRequirement {
  id: UUID;
  patient_id: UUID;
  service_id: UUID;
  minimum_hours_per_week: number | null;
  maximum_hours_per_week: number | null;
  minimum_sessions_per_week: number | null;
  maximum_sessions_per_week: number | null;
  target_hours_per_week: number | null;
  target_sessions_per_week: number | null;
  required: boolean;
  priority: number;
  effective_start: DateOnly;
  effective_end: DateOnly | null;
}

export interface Authorization {
  id: UUID;
  patient_id: UUID;
  service_id: UUID;
  payer: string | null;
  authorization_number: string | null;
  authorized_hours: number | null;
  authorized_units: number | null;
  units_per_hour: number;
  start_date: DateOnly;
  end_date: DateOnly;
  status: AuthorizationStatus;
}

export interface Provider {
  id: UUID;
  external_id: string | null;
  first_name: string;
  last_name: string;
  provider_type: ProviderType;
  status: ProviderStatus;
  timezone: string;
  home_location_id: UUID | null;
}

export interface ProviderCredential {
  id: UUID;
  provider_id: UUID;
  credential_type: string;
  credential_number: string | null;
  state: string | null;
  issue_date: DateOnly | null;
  expiration_date: DateOnly | null;
  status: CredentialStatus;
}

export interface ProviderService {
  id: UUID;
  provider_id: UUID;
  service_id: UUID;
  eligible: boolean;
  effective_start: DateOnly | null;
  effective_end: DateOnly | null;
}

export interface ProviderAvailability {
  id: UUID;
  provider_id: UUID;
  day_of_week: Weekday;
  start_time: ClockTime;
  end_time: ClockTime;
  availability_type: ProviderAvailabilityType;
  location_id: UUID | null;
  effective_start: DateOnly | null;
  effective_end: DateOnly | null;
}

export interface PatientAvailability {
  id: UUID;
  patient_id: UUID;
  day_of_week: Weekday;
  start_time: ClockTime;
  end_time: ClockTime;
  availability_type: PatientAvailabilityType;
  effective_start: DateOnly | null;
  effective_end: DateOnly | null;
}

export interface PatientPreference {
  id: UUID;
  patient_id: UUID;
  preferred_service_id: UUID | null;
  preferred_day: Weekday | null;
  preferred_start_time: ClockTime | null;
  preferred_end_time: ClockTime | null;
  preferred_provider_id: UUID | null;
  preferred_location_id: UUID | null;
  priority: number;
  is_hard_constraint: boolean;
}

export interface PatientRestriction {
  id: UUID;
  patient_id: UUID;
  restriction_type: RestrictionType;
  day_of_week: Weekday;
  start_time: ClockTime;
  end_time: ClockTime;
  /** null blocks every service; set permits only that one service. */
  service_allowed: UUID | null;
  effective_start: DateOnly | null;
  effective_end: DateOnly | null;
}

export interface Resource {
  id: UUID;
  name: string;
  resource_type: string;
  location_id: UUID | null;
  capacity: number;
  active: boolean;
}

export interface ServiceResource {
  id: UUID;
  service_id: UUID;
  resource_id: UUID;
  required: boolean;
}

export interface Appointment {
  id: UUID;
  patient_id: UUID;
  service_id: UUID;
  provider_id: UUID | null;
  authorization_id: UUID | null;
  location_id: UUID | null;
  start_time: Timestamp;
  end_time: Timestamp;
  status: AppointmentStatus;
  scheduling_flexibility: SchedulingFlexibility;
  telehealth: boolean;
  original_start_time: Timestamp | null;
  original_provider_id: UUID | null;
  original_location_id: UUID | null;
}

export interface AppointmentResource {
  id: UUID;
  appointment_id: UUID;
  resource_id: UUID;
}

/**
 * The intermediate model the solver will consume (spec section 27). Raw
 * database rows never reach CP-SAT; they are compiled into these first, which
 * is what keeps the solver service-agnostic.
 */
export interface CandidateAppointment {
  candidate_id: string;
  patient_id: UUID;
  service_id: UUID;
  provider_id: UUID;
  authorization_id: UUID | null;
  start_slot: number;
  duration_slots: number;
  end_slot: number;
  location_id: UUID | null;
  resource_ids: UUID[];
  is_existing: boolean;
  flexibility: SchedulingFlexibility;
  service_priority: number;
  required_service: boolean;
  target_service: boolean;
  objective_values: Record<string, number>;
}

/** Statuses that still occupy time on a calendar. */
export const OCCUPYING_STATUSES: readonly AppointmentStatus[] = [
  "SCHEDULED",
  "CONFIRMED",
  "COMPLETED",
];

export function occupiesTime(appointment: Appointment): boolean {
  return OCCUPYING_STATUSES.includes(appointment.status);
}
