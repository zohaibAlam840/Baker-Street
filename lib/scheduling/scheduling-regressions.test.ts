import { describe, expect, it } from "vitest";

import { SLOTS_PER_DAY, SlotGrid } from "../domain/slots";
import type { Resource } from "../domain/types";
import { ScheduleContext, type SnapshotRows } from "../rules/context";
import { generateCandidates } from "./candidates";
import { optimizePatientWeek } from "./optimizer";

const TZ = "America/New_York";
const DEFAULT_WEEK = "2026-09-21";

const ID = {
  targetPatient: "patient-target",
  blockingPatient: "patient-blocking",
  service: "service-therapy",
  duration: "duration-therapy-60",
  provider: "provider-clinician",
  clinicA: "location-clinic-a",
  clinicB: "location-clinic-b",
  roomA: "resource-room-a",
  roomB: "resource-room-b",
  portable: "resource-portable",
  requirement: "requirement-therapy",
} as const;

interface FixtureOptions {
  weekStart?: string;
  dayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  startTime?: string;
  endTime?: string;
  providerHomeLocation?: string | null;
  providerAvailabilityLocation?: string | null;
  resources?: Resource[];
  serviceResourceOrder?: string[];
  occupiedResourceId?: string;
}

function resource(
  id: string,
  locationId: string | null,
  name = id,
): Resource {
  return {
    id,
    name,
    resource_type: "THERAPY_ROOM",
    location_id: locationId,
    capacity: 1,
    active: true,
  };
}

function buildFixture(options: FixtureOptions = {}): {
  ctx: ScheduleContext;
  rows: SnapshotRows;
} {
  const weekStart = options.weekStart ?? DEFAULT_WEEK;
  const grid = SlotGrid.week(weekStart, TZ);
  const resources = options.resources ?? [resource(ID.roomA, ID.clinicA)];
  const resourceIds =
    options.serviceResourceOrder ?? resources.map((row) => row.id);
  const occupiedResource = options.occupiedResourceId
    ? resources.find((row) => row.id === options.occupiedResourceId)
    : undefined;
  const occupiedRange = {
    start_time: grid.instantOf(9 * 4).toISOString(),
    end_time: grid.instantOf(10 * 4).toISOString(),
  };

  const rows: SnapshotRows = {
    patients: [
      {
        id: ID.targetPatient,
        external_id: null,
        first_name: "Taylor",
        last_name: "Target",
        date_of_birth: null,
        status: "ACTIVE",
        timezone: TZ,
        primary_location_id: ID.clinicA,
      },
      {
        id: ID.blockingPatient,
        external_id: null,
        first_name: "Blake",
        last_name: "Blocking",
        date_of_birth: null,
        status: "ACTIVE",
        timezone: TZ,
        primary_location_id: ID.clinicA,
      },
    ],
    services: [
      {
        id: ID.service,
        service_code: "THERAPY",
        service_name: "Therapy",
        department: "Clinical",
        active: true,
        default_duration_minutes: 60,
        min_duration_minutes: 60,
        max_duration_minutes: 60,
        telehealth_allowed: false,
        in_person_allowed: true,
        group_allowed: false,
        requires_authorization: false,
        optimization_profile: { primary_objective: "COMPLETE_REQUIRED_SERVICES" },
      },
    ],
    serviceDurations: [
      {
        id: ID.duration,
        service_id: ID.service,
        duration_minutes: 60,
        active: true,
      },
    ],
    serviceResources: resourceIds.map((resourceId, index) => ({
      id: `service-resource-${index}-${resourceId}`,
      service_id: ID.service,
      resource_id: resourceId,
      required: true,
    })),
    providers: [
      {
        id: ID.provider,
        external_id: null,
        first_name: "Casey",
        last_name: "Clinician",
        provider_type: "BCBA",
        status: "ACTIVE",
        timezone: TZ,
        home_location_id: options.providerHomeLocation ?? ID.clinicA,
      },
    ],
    providerServices: [
      {
        id: "provider-service-therapy",
        provider_id: ID.provider,
        service_id: ID.service,
        eligible: true,
        effective_start: null,
        effective_end: null,
      },
    ],
    providerCredentials: [],
    providerAvailability: [
      {
        id: "provider-availability",
        provider_id: ID.provider,
        day_of_week: options.dayOfWeek ?? 1,
        start_time: options.startTime ?? "09:00",
        end_time: options.endTime ?? "10:00",
        availability_type: "CLINICAL",
        location_id:
          options.providerAvailabilityLocation === undefined
            ? ID.clinicA
            : options.providerAvailabilityLocation,
        effective_start: null,
        effective_end: null,
      },
    ],
    patientAvailability: [
      {
        id: "patient-availability",
        patient_id: ID.targetPatient,
        day_of_week: options.dayOfWeek ?? 1,
        start_time: options.startTime ?? "09:00",
        end_time: options.endTime ?? "10:00",
        availability_type: "AVAILABLE",
        effective_start: null,
        effective_end: null,
      },
    ],
    patientRestrictions: [],
    patientPreferences: [],
    patientServiceRequirements: [
      {
        id: ID.requirement,
        patient_id: ID.targetPatient,
        service_id: ID.service,
        minimum_hours_per_week: 1,
        maximum_hours_per_week: 1,
        minimum_sessions_per_week: 1,
        maximum_sessions_per_week: 1,
        target_hours_per_week: 1,
        target_sessions_per_week: 1,
        required: true,
        priority: 1,
        effective_start: "2026-01-01",
        effective_end: null,
      },
    ],
    authorizations: [],
    locations: [
      {
        id: ID.clinicA,
        name: "Clinic A",
        type: "CLINIC",
        city: null,
        state: null,
        timezone: TZ,
        active: true,
      },
      {
        id: ID.clinicB,
        name: "Clinic B",
        type: "CLINIC",
        city: null,
        state: null,
        timezone: TZ,
        active: true,
      },
    ],
    resources,
    appointments: occupiedResource
      ? [
          {
            id: "appointment-occupying-room",
            patient_id: ID.blockingPatient,
            service_id: ID.service,
            provider_id: null,
            authorization_id: null,
            location_id: occupiedResource.location_id,
            ...occupiedRange,
            status: "SCHEDULED",
            scheduling_flexibility: "LOCKED",
            telehealth: false,
            original_start_time: null,
            original_provider_id: null,
            original_location_id: null,
          },
        ]
      : [],
    appointmentResources: occupiedResource
      ? [
          {
            appointment_id: "appointment-occupying-room",
            resource_id: occupiedResource.id,
          },
        ]
      : [],
  };

  return { ctx: new ScheduleContext(grid, rows), rows };
}

function reversedRows(rows: SnapshotRows): SnapshotRows {
  return {
    patients: [...rows.patients].reverse(),
    services: [...rows.services].reverse(),
    serviceDurations: [...rows.serviceDurations].reverse(),
    serviceResources: [...rows.serviceResources].reverse(),
    providers: [...rows.providers].reverse(),
    providerServices: [...rows.providerServices].reverse(),
    providerCredentials: [...rows.providerCredentials].reverse(),
    providerAvailability: [...rows.providerAvailability].reverse(),
    patientAvailability: [...rows.patientAvailability].reverse(),
    patientRestrictions: [...rows.patientRestrictions].reverse(),
    patientPreferences: [...rows.patientPreferences].reverse(),
    patientServiceRequirements: [...rows.patientServiceRequirements].reverse(),
    authorizations: [...rows.authorizations].reverse(),
    locations: [...rows.locations].reverse(),
    resources: [...rows.resources].reverse(),
    appointments: [...rows.appointments].reverse(),
    appointmentResources: [...rows.appointmentResources].reverse(),
  };
}

function candidatesFor(ctx: ScheduleContext) {
  return generateCandidates(ctx, {
    patient_id: ID.targetPatient,
    service_ids: [ID.service],
    includeExisting: false,
    startStepSlots: 1,
  });
}

describe("scheduling regressions", () => {
  it("falls back to another eligible room when the first room is full", () => {
    const { ctx } = buildFixture({
      resources: [
        resource(ID.roomA, ID.clinicA, "Room A"),
        resource(ID.roomB, ID.clinicA, "Room B"),
      ],
      serviceResourceOrder: [ID.roomA, ID.roomB],
      occupiedResourceId: ID.roomA,
    });

    const result = candidatesFor(ctx);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].resource_ids).toEqual([ID.roomB]);
  });

  it("allows a portable resource whose location is null", () => {
    const { ctx } = buildFixture({
      resources: [
        resource(ID.roomB, ID.clinicB, "Wrong-site room"),
        resource(ID.portable, null, "Portable kit"),
      ],
      serviceResourceOrder: [ID.roomB, ID.portable],
    });

    const result = candidatesFor(ctx);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      location_id: ID.clinicA,
      resource_ids: [ID.portable],
    });
  });

  it("uses the clinical availability location instead of the provider home location", () => {
    const { ctx } = buildFixture({
      providerHomeLocation: ID.clinicA,
      providerAvailabilityLocation: ID.clinicB,
      resources: [resource(ID.roomB, ID.clinicB, "Clinic B room")],
      serviceResourceOrder: [ID.roomB],
    });

    const result = candidatesFor(ctx);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      location_id: ID.clinicB,
      resource_ids: [ID.roomB],
    });
  });

  it("produces identical plan IDs and selections regardless of snapshot row order", () => {
    const { ctx, rows } = buildFixture({
      resources: [
        resource(ID.roomA, ID.clinicA, "Room A"),
        resource(ID.roomB, ID.clinicA, "Room B"),
      ],
      serviceResourceOrder: [ID.roomA, ID.roomB],
    });
    const reversed = new ScheduleContext(ctx.grid, reversedRows(rows));
    const request = {
      patient_id: ID.targetPatient,
      max_solutions: 5,
      max_search_candidates: 20,
      beam_width: 20,
      max_search_operations: 2_000,
      start_step_slots: 1,
    } as const;

    const forwardResult = optimizePatientWeek(ctx, request);
    const reversedResult = optimizePatientWeek(reversed, request);
    const planIdentity = (result: typeof forwardResult) =>
      result.plans.map((plan) => ({
        id: plan.id,
        candidateIds: plan.appointments.map((row) => row.candidate_id),
      }));

    expect(forwardResult.plans.length).toBeGreaterThan(0);
    expect(planIdentity(reversedResult)).toEqual(planIdentity(forwardResult));
  });

  it("rejects a SlotGrid range inside the spring-forward DST gap", () => {
    const { ctx } = buildFixture({
      weekStart: "2026-03-02",
      dayOfWeek: 0,
      startTime: "02:00",
      endTime: "03:00",
    });
    const sundayAtTwo = 6 * SLOTS_PER_DAY + 2 * 4;

    expect(
      ctx.grid.isValidWallClockRange({
        startSlot: sundayAtTwo,
        endSlot: sundayAtTwo + 4,
      }),
    ).toBe(false);

    const result = candidatesFor(ctx);
    expect(result.candidates).toEqual([]);
    expect(result.rejectionsByCode.LOCAL_TIME_INVALID).toBeGreaterThan(0);
  });
});
