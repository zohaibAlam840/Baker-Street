/**
 * The acceptance scenario from spec sections 70 and 77, built in memory.
 *
 *   Patient: 30h ABA authorized, 27h currently scheduled,
 *            1 Therapy + 1 OT + 1 Parent Training session required,
 *            multiple eligible RBTs on different availability patterns,
 *            multiple locations, protected appointments, a school block.
 *
 *   "Get this patient as close to 30 ABA hours as possible while preserving
 *    the required services."
 *
 * The week is deliberately tight: exactly 3 unbooked hours sit inside the
 * patient's availability, on Saturday afternoon, and the only RBT free for all
 * three is at the other clinic. That makes the scenario prove something rather
 * than merely run.
 */

import { SLOTS_PER_DAY, SLOT_MINUTES, SlotGrid } from "../domain/slots";
import { ScheduleContext, SnapshotRows } from "../rules/context";
import type { Weekday } from "../domain/time";

export const TZ = "America/New_York";
export const WEEK_START = "2026-09-21"; // Monday

const MON: Weekday = 1;
const TUE: Weekday = 2;
const WED: Weekday = 3;
const THU: Weekday = 4;
const FRI: Weekday = 5;
const SAT: Weekday = 6;
const WEEKDAYS: Weekday[] = [MON, TUE, WED, THU, FRI];

/** Readable stand-ins for UUIDs; the rules never parse them. */
export const ID = {
  // Locations
  clinicNorth: "loc-clinic-north",
  clinicSouth: "loc-clinic-south",
  telehealth: "loc-telehealth",
  home: "loc-home",
  // Services
  aba: "svc-aba-direct",
  supervision: "svc-bcba-supervision",
  parentTraining: "svc-parent-training",
  therapy: "svc-therapy",
  ot: "svc-ot",
  neuropsych: "svc-neuropsych",
  // People
  john: "pat-john",
  rbtAlice: "prv-rbt-alice",
  rbtBen: "prv-rbt-ben",
  rbtCara: "prv-rbt-cara",
  rbtDan: "prv-rbt-dan",
  bcbaEve: "prv-bcba-eve",
  therapistFay: "prv-lmhc-fay",
  otGil: "prv-ot-gil",
  // Resources
  abaRoom1: "res-aba-room-1",
  abaRoom2: "res-aba-room-2",
  otGym: "res-ot-gym",
  therapyRoom: "res-therapy-room",
  testingRoom: "res-testing-room",
  // Authorizations
  abaAuth: "auth-aba-30h",
  // Appointments
  abaMon: "apt-aba-mon",
  abaTue: "apt-aba-tue",
  abaWed: "apt-aba-wed",
  abaThu: "apt-aba-thu",
  abaFri: "apt-aba-fri",
  abaSat: "apt-aba-sat",
  therapyTue: "apt-therapy-tue",
  otThu: "apt-ot-thu",
  parentTrainingSat: "apt-parent-training-sat",
} as const;

const FIXTURE_GRID = SlotGrid.week(WEEK_START, TZ);

/** Local wall-clock instant on a horizon day, as an ISO string. */
function at(dayOffset: number, clock: string): string {
  const [hour, minute] = clock.split(":").map(Number);
  const base = FIXTURE_GRID.dayStart(dayOffset).getTime();
  return new Date(base + (hour * 60 + minute) * 60_000).toISOString();
}

// Day offsets from Monday.
const D = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 } as const;

export function buildScenarioRows(): SnapshotRows {
  return {
    // -----------------------------------------------------------------------
    // Locations
    // -----------------------------------------------------------------------
    locations: [
      { id: ID.clinicNorth, name: "North Clinic", type: "CLINIC", city: "Boston", state: "MA", timezone: TZ, active: true },
      { id: ID.clinicSouth, name: "South Clinic", type: "CLINIC", city: "Quincy", state: "MA", timezone: TZ, active: true },
      { id: ID.telehealth, name: "Telehealth", type: "TELEHEALTH", city: null, state: null, timezone: TZ, active: true },
      { id: ID.home, name: "Patient Home", type: "HOME", city: "Boston", state: "MA", timezone: TZ, active: true },
    ],

    // -----------------------------------------------------------------------
    // Services -- ABA is one row among several, with no special status
    // -----------------------------------------------------------------------
    services: [
      {
        id: ID.aba,
        service_code: "ABA_DIRECT",
        service_name: "ABA Direct Treatment",
        department: "ABA",
        active: true,
        default_duration_minutes: 120,
        min_duration_minutes: 30,
        max_duration_minutes: 300,
        telehealth_allowed: false,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: true,
        optimization_profile: {
          primary_objective: "MAXIMIZE_SERVICE_HOURS",
          authorization_limit: true,
          clinical_target: true,
          continuity_weight: 10,
          preference_weight: 5,
        },
      },
      {
        id: ID.supervision,
        service_code: "BCBA_SUPERVISION",
        service_name: "BCBA Supervision",
        department: "ABA",
        active: true,
        default_duration_minutes: 60,
        min_duration_minutes: 30,
        max_duration_minutes: 120,
        telehealth_allowed: true,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: false,
        optimization_profile: { primary_objective: "MAXIMIZE_SERVICE_SESSIONS" },
      },
      {
        id: ID.parentTraining,
        service_code: "PARENT_TRAINING",
        service_name: "Parent Training",
        department: "ABA",
        active: true,
        default_duration_minutes: 60,
        min_duration_minutes: 30,
        max_duration_minutes: 120,
        telehealth_allowed: true,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: false,
        optimization_profile: { primary_objective: "COMPLETE_REQUIRED_SERVICES" },
      },
      {
        id: ID.therapy,
        service_code: "THERAPY",
        service_name: "Psychotherapy",
        department: "Behavioral Health",
        active: true,
        default_duration_minutes: 60,
        min_duration_minutes: 45,
        max_duration_minutes: 60,
        telehealth_allowed: true,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: false,
        optimization_profile: { primary_objective: "COMPLETE_REQUIRED_SERVICES" },
      },
      {
        id: ID.ot,
        service_code: "OT",
        service_name: "Occupational Therapy",
        department: "Rehabilitation",
        active: true,
        default_duration_minutes: 60,
        min_duration_minutes: 30,
        max_duration_minutes: 60,
        telehealth_allowed: false,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: false,
        optimization_profile: { primary_objective: "COMPLETE_REQUIRED_SERVICES" },
      },
      {
        id: ID.neuropsych,
        service_code: "NEUROPSYCH_TESTING",
        service_name: "Neuropsychological Testing",
        department: "Psychology",
        active: true,
        default_duration_minutes: 180,
        min_duration_minutes: 60,
        max_duration_minutes: 240,
        telehealth_allowed: false,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: false,
        optimization_profile: { primary_objective: "COMPLETE_REQUIRED_SERVICES" },
      },
    ],

    serviceDurations: [
      ...[30, 60, 90, 120, 180, 240, 300].map((m) => ({
        id: `dur-aba-${m}`, service_id: ID.aba, duration_minutes: m, active: true,
      })),
      ...[30, 60, 90, 120].map((m) => ({
        id: `dur-sup-${m}`, service_id: ID.supervision, duration_minutes: m, active: true,
      })),
      ...[30, 60, 90, 120].map((m) => ({
        id: `dur-pt-${m}`, service_id: ID.parentTraining, duration_minutes: m, active: true,
      })),
      ...[45, 60].map((m) => ({
        id: `dur-thr-${m}`, service_id: ID.therapy, duration_minutes: m, active: true,
      })),
      ...[30, 45, 60].map((m) => ({
        id: `dur-ot-${m}`, service_id: ID.ot, duration_minutes: m, active: true,
      })),
      ...[60, 90, 120, 180].map((m) => ({
        id: `dur-np-${m}`, service_id: ID.neuropsych, duration_minutes: m, active: true,
      })),
    ],

    // OT needs the gym, therapy needs the therapy room, testing needs the
    // testing room. ABA can happen anywhere, which is what makes it the
    // service with room to optimize.
    serviceResources: [
      { id: "sr-ot", service_id: ID.ot, resource_id: ID.otGym, required: true },
      { id: "sr-thr", service_id: ID.therapy, resource_id: ID.therapyRoom, required: true },
      { id: "sr-np", service_id: ID.neuropsych, resource_id: ID.testingRoom, required: true },
    ],

    resources: [
      { id: ID.abaRoom1, name: "ABA Room 1", resource_type: "ROOM", location_id: ID.clinicNorth, capacity: 1, active: true },
      { id: ID.abaRoom2, name: "ABA Room 2", resource_type: "ROOM", location_id: ID.clinicNorth, capacity: 1, active: true },
      { id: ID.otGym, name: "OT Gym", resource_type: "GYM", location_id: ID.clinicNorth, capacity: 2, active: true },
      { id: ID.therapyRoom, name: "Therapy Room 1", resource_type: "ROOM", location_id: ID.clinicNorth, capacity: 1, active: true },
      { id: ID.testingRoom, name: "Neuropsych Testing Room", resource_type: "ROOM", location_id: ID.clinicNorth, capacity: 1, active: true },
    ],

    // -----------------------------------------------------------------------
    // Patient
    // -----------------------------------------------------------------------
    patients: [
      {
        id: ID.john,
        external_id: "BSH-1001",
        first_name: "John",
        last_name: "Reyes",
        date_of_birth: "2017-04-12",
        status: "ACTIVE",
        timezone: TZ,
        primary_location_id: ID.clinicNorth,
      },
    ],

    // Weekdays 08:00-18:00, Saturday 09:00-17:00.
    patientAvailability: [
      ...WEEKDAYS.map((day) => ({
        id: `pav-${day}`,
        patient_id: ID.john,
        day_of_week: day,
        start_time: "08:00",
        end_time: "18:00",
        availability_type: "AVAILABLE" as const,
        effective_start: null,
        effective_end: null,
      })),
      {
        id: "pav-sat",
        patient_id: ID.john,
        day_of_week: SAT,
        start_time: "09:00",
        end_time: "17:00",
        availability_type: "AVAILABLE" as const,
        effective_start: null,
        effective_end: null,
      },
    ],

    // School blocks every service on weekday mornings.
    patientRestrictions: WEEKDAYS.map((day) => ({
      id: `pres-school-${day}`,
      patient_id: ID.john,
      restriction_type: "SCHOOL" as const,
      day_of_week: day,
      start_time: "08:30",
      end_time: "12:30",
      service_allowed: null,
      effective_start: null,
      effective_end: null,
    })),

    patientPreferences: [
      {
        id: "ppref-continuity",
        patient_id: ID.john,
        preferred_service_id: ID.aba,
        preferred_day: null,
        preferred_start_time: null,
        preferred_end_time: null,
        preferred_provider_id: ID.rbtAlice,
        preferred_location_id: ID.clinicNorth,
        priority: 10,
        is_hard_constraint: false,
      },
    ],

    /**
     * Clinical need, stated independently of what the payer authorized:
     * floor 20h, target 30h, ceiling 30h for ABA; one required session each
     * for therapy, OT and parent training.
     */
    patientServiceRequirements: [
      {
        id: "psr-aba",
        patient_id: ID.john,
        service_id: ID.aba,
        minimum_hours_per_week: 20,
        maximum_hours_per_week: 30,
        minimum_sessions_per_week: null,
        maximum_sessions_per_week: null,
        target_hours_per_week: 30,
        target_sessions_per_week: null,
        required: true,
        priority: 10,
        effective_start: "2026-01-01",
        effective_end: null,
      },
      {
        id: "psr-therapy",
        patient_id: ID.john,
        service_id: ID.therapy,
        minimum_hours_per_week: null,
        maximum_hours_per_week: null,
        minimum_sessions_per_week: 1,
        maximum_sessions_per_week: 1,
        target_hours_per_week: null,
        target_sessions_per_week: 1,
        required: true,
        priority: 5,
        effective_start: "2026-01-01",
        effective_end: null,
      },
      {
        id: "psr-ot",
        patient_id: ID.john,
        service_id: ID.ot,
        minimum_hours_per_week: null,
        maximum_hours_per_week: null,
        minimum_sessions_per_week: 1,
        maximum_sessions_per_week: 1,
        target_hours_per_week: null,
        target_sessions_per_week: 1,
        required: true,
        priority: 5,
        effective_start: "2026-01-01",
        effective_end: null,
      },
      {
        id: "psr-parent-training",
        patient_id: ID.john,
        service_id: ID.parentTraining,
        minimum_hours_per_week: null,
        maximum_hours_per_week: null,
        minimum_sessions_per_week: 1,
        maximum_sessions_per_week: 1,
        target_hours_per_week: null,
        target_sessions_per_week: 1,
        required: true,
        priority: 5,
        effective_start: "2026-01-01",
        effective_end: null,
      },
    ],

    // 30 authorized hours for exactly this week.
    authorizations: [
      {
        id: ID.abaAuth,
        patient_id: ID.john,
        service_id: ID.aba,
        payer: "Commonwealth Health",
        authorization_number: "AUTH-9931",
        authorized_hours: 30,
        authorized_units: 120,
        units_per_hour: 4,
        start_date: "2026-09-21",
        end_date: "2026-09-27",
        status: "ACTIVE",
      },
    ],

    // -----------------------------------------------------------------------
    // Providers
    // -----------------------------------------------------------------------
    providers: [
      { id: ID.rbtAlice, external_id: "RBT-01", first_name: "Alice", last_name: "Moreau", provider_type: "RBT", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicNorth },
      { id: ID.rbtBen, external_id: "RBT-02", first_name: "Ben", last_name: "Okafor", provider_type: "RBT", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicNorth },
      { id: ID.rbtCara, external_id: "RBT-03", first_name: "Cara", last_name: "Lindqvist", provider_type: "RBT", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicSouth },
      { id: ID.rbtDan, external_id: "RBT-04", first_name: "Dan", last_name: "Pryce", provider_type: "RBT", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicNorth },
      { id: ID.bcbaEve, external_id: "BCBA-01", first_name: "Eve", last_name: "Nakamura", provider_type: "BCBA", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicNorth },
      { id: ID.therapistFay, external_id: "LMHC-01", first_name: "Fay", last_name: "Duarte", provider_type: "LMHC", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicNorth },
      { id: ID.otGil, external_id: "OT-01", first_name: "Gil", last_name: "Hassan", provider_type: "OT", status: "ACTIVE", timezone: TZ, home_location_id: ID.clinicNorth },
    ],

    providerCredentials: [
      { id: "cred-alice", provider_id: ID.rbtAlice, credential_type: "RBT", credential_number: "RBT-11111", state: "MA", issue_date: "2024-01-01", expiration_date: "2027-06-30", status: "ACTIVE" },
      { id: "cred-ben", provider_id: ID.rbtBen, credential_type: "RBT", credential_number: "RBT-22222", state: "MA", issue_date: "2024-01-01", expiration_date: "2027-06-30", status: "ACTIVE" },
      { id: "cred-cara", provider_id: ID.rbtCara, credential_type: "RBT", credential_number: "RBT-33333", state: "MA", issue_date: "2024-01-01", expiration_date: "2027-06-30", status: "ACTIVE" },
      // Dan looks eligible on paper but his certification lapsed in August.
      { id: "cred-dan", provider_id: ID.rbtDan, credential_type: "RBT", credential_number: "RBT-44444", state: "MA", issue_date: "2023-01-01", expiration_date: "2026-08-31", status: "ACTIVE" },
      { id: "cred-eve", provider_id: ID.bcbaEve, credential_type: "BCBA", credential_number: "BCBA-555", state: "MA", issue_date: "2020-01-01", expiration_date: "2028-01-31", status: "ACTIVE" },
      { id: "cred-fay", provider_id: ID.therapistFay, credential_type: "LMHC", credential_number: "LMHC-666", state: "MA", issue_date: "2019-01-01", expiration_date: "2027-12-31", status: "ACTIVE" },
      { id: "cred-gil", provider_id: ID.otGil, credential_type: "OT", credential_number: "OT-777", state: "MA", issue_date: "2021-01-01", expiration_date: "2027-12-31", status: "ACTIVE" },
    ],

    providerServices: [
      { id: "ps-alice-aba", provider_id: ID.rbtAlice, service_id: ID.aba, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-ben-aba", provider_id: ID.rbtBen, service_id: ID.aba, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-cara-aba", provider_id: ID.rbtCara, service_id: ID.aba, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-dan-aba", provider_id: ID.rbtDan, service_id: ID.aba, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-eve-sup", provider_id: ID.bcbaEve, service_id: ID.supervision, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-eve-pt", provider_id: ID.bcbaEve, service_id: ID.parentTraining, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-eve-aba", provider_id: ID.bcbaEve, service_id: ID.aba, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-fay-thr", provider_id: ID.therapistFay, service_id: ID.therapy, eligible: true, effective_start: null, effective_end: null },
      { id: "ps-gil-ot", provider_id: ID.otGil, service_id: ID.ot, eligible: true, effective_start: null, effective_end: null },
    ],

    /**
     * Four different availability patterns, which is what makes the Saturday
     * question interesting: Alice leaves at 15:00 and Cara is at the other
     * clinic.
     */
    providerAvailability: [
      ...WEEKDAYS.map((day) => ({
        id: `prav-alice-${day}`, provider_id: ID.rbtAlice, day_of_week: day,
        start_time: "12:00", end_time: "18:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      })),
      {
        id: "prav-alice-sat", provider_id: ID.rbtAlice, day_of_week: SAT,
        start_time: "09:00", end_time: "15:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      },
      ...WEEKDAYS.map((day) => ({
        id: `prav-ben-${day}`, provider_id: ID.rbtBen, day_of_week: day,
        start_time: "08:00", end_time: "16:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      })),
      ...[WED, THU, FRI, SAT].map((day) => ({
        id: `prav-cara-${day}`, provider_id: ID.rbtCara, day_of_week: day,
        start_time: "12:00", end_time: "18:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicSouth,
        effective_start: null, effective_end: null,
      })),
      ...WEEKDAYS.map((day) => ({
        id: `prav-dan-${day}`, provider_id: ID.rbtDan, day_of_week: day,
        start_time: "12:00", end_time: "18:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      })),
      {
        id: "prav-eve-weekdays", provider_id: ID.bcbaEve, day_of_week: WED,
        start_time: "09:00", end_time: "17:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      },
      {
        id: "prav-eve-sat", provider_id: ID.bcbaEve, day_of_week: SAT,
        start_time: "09:00", end_time: "16:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      },
      {
        id: "prav-fay-tue", provider_id: ID.therapistFay, day_of_week: TUE,
        start_time: "13:00", end_time: "19:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      },
      {
        id: "prav-gil-thu", provider_id: ID.otGil, day_of_week: THU,
        start_time: "13:00", end_time: "19:00",
        availability_type: "CLINICAL" as const, location_id: ID.clinicNorth,
        effective_start: null, effective_end: null,
      },
      // Alice takes Tuesday afternoon off the following month; proves that
      // effective-dated rows are ignored outside their range.
      {
        id: "prav-alice-pto-future", provider_id: ID.rbtAlice, day_of_week: TUE,
        start_time: "12:00", end_time: "18:00",
        availability_type: "PTO" as const, location_id: null,
        effective_start: "2026-10-01", effective_end: "2026-10-31",
      },
    ],

    // -----------------------------------------------------------------------
    // The existing week: 27h ABA + the three required services
    // -----------------------------------------------------------------------
    appointments: [
      {
        id: ID.abaMon, patient_id: ID.john, service_id: ID.aba, provider_id: ID.rbtAlice,
        authorization_id: ID.abaAuth, location_id: ID.clinicNorth,
        start_time: at(D.mon, "13:00"), end_time: at(D.mon, "18:00"),
        status: "SCHEDULED", scheduling_flexibility: "FLEXIBLE", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.abaTue, patient_id: ID.john, service_id: ID.aba, provider_id: ID.rbtAlice,
        authorization_id: ID.abaAuth, location_id: ID.clinicNorth,
        start_time: at(D.tue, "13:00"), end_time: at(D.tue, "17:00"),
        status: "SCHEDULED", scheduling_flexibility: "FLEXIBLE", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.abaWed, patient_id: ID.john, service_id: ID.aba, provider_id: ID.rbtAlice,
        authorization_id: ID.abaAuth, location_id: ID.clinicNorth,
        start_time: at(D.wed, "13:00"), end_time: at(D.wed, "18:00"),
        status: "SCHEDULED", scheduling_flexibility: "FLEXIBLE", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.abaThu, patient_id: ID.john, service_id: ID.aba, provider_id: ID.rbtAlice,
        authorization_id: ID.abaAuth, location_id: ID.clinicNorth,
        start_time: at(D.thu, "13:00"), end_time: at(D.thu, "17:00"),
        status: "SCHEDULED", scheduling_flexibility: "FLEXIBLE", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.abaFri, patient_id: ID.john, service_id: ID.aba, provider_id: ID.rbtAlice,
        authorization_id: ID.abaAuth, location_id: ID.clinicNorth,
        start_time: at(D.fri, "13:00"), end_time: at(D.fri, "18:00"),
        status: "SCHEDULED", scheduling_flexibility: "FLEXIBLE", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.abaSat, patient_id: ID.john, service_id: ID.aba, provider_id: ID.rbtAlice,
        authorization_id: ID.abaAuth, location_id: ID.clinicNorth,
        start_time: at(D.sat, "09:00"), end_time: at(D.sat, "13:00"),
        status: "SCHEDULED", scheduling_flexibility: "FLEXIBLE", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      // The three required services, all PROTECTED: movable only at heavy cost.
      {
        id: ID.therapyTue, patient_id: ID.john, service_id: ID.therapy, provider_id: ID.therapistFay,
        authorization_id: null, location_id: ID.clinicNorth,
        start_time: at(D.tue, "17:00"), end_time: at(D.tue, "18:00"),
        status: "SCHEDULED", scheduling_flexibility: "PROTECTED", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.otThu, patient_id: ID.john, service_id: ID.ot, provider_id: ID.otGil,
        authorization_id: null, location_id: ID.clinicNorth,
        start_time: at(D.thu, "17:00"), end_time: at(D.thu, "18:00"),
        status: "SCHEDULED", scheduling_flexibility: "PROTECTED", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
      {
        id: ID.parentTrainingSat, patient_id: ID.john, service_id: ID.parentTraining, provider_id: ID.bcbaEve,
        authorization_id: null, location_id: ID.clinicNorth,
        start_time: at(D.sat, "13:00"), end_time: at(D.sat, "14:00"),
        status: "SCHEDULED", scheduling_flexibility: "LOCKED", telehealth: false,
        original_start_time: null, original_provider_id: null, original_location_id: null,
      },
    ],

    appointmentResources: [
      { appointment_id: ID.therapyTue, resource_id: ID.therapyRoom },
      { appointment_id: ID.otThu, resource_id: ID.otGym },
    ],
  };
}

export function buildScenario(): {
  grid: SlotGrid;
  rows: SnapshotRows;
  ctx: ScheduleContext;
} {
  const grid = SlotGrid.week(WEEK_START, TZ);
  const rows = buildScenarioRows();
  return { grid, rows, ctx: new ScheduleContext(grid, rows) };
}

/** Local wall-clock helper for tests: `slotFor("tue", "13:00")`. */
export function slotFor(day: keyof typeof D, clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return D[day] * SLOTS_PER_DAY + (hour * 60 + minute) / SLOT_MINUTES;
}

/** A slot range from local wall-clock times on one day. */
export function rangeFor(day: keyof typeof D, from: string, to: string) {
  return { startSlot: slotFor(day, from), endSlot: slotFor(day, to) };
}

export { D as DAY };
