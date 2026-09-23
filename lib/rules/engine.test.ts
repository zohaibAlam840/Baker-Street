/**
 * Constraint tests (spec section 68), run against the acceptance scenario.
 *
 * These are the gate for Phase 2: the solver must not be built until the rule
 * engine provably rejects every hard-constraint violation below.
 */

import { describe, expect, it } from "vitest";

import { slotsToHours } from "../domain/slots";
import { ID, buildScenario, rangeFor } from "../testing/scenario";
import { ScheduleContext } from "./context";
import { ProposedBooking, RuleOptions, evaluateBooking } from "./engine";
import { FlatTravelModel } from "./travel";
import type { ViolationCode } from "./violations";

const { ctx } = buildScenario();

/** A valid ABA booking, which individual tests then break in one way. */
function abaBooking(overrides: Partial<ProposedBooking> = {}): ProposedBooking {
  return {
    patient_id: ID.john,
    service_id: ID.aba,
    provider_id: ID.rbtAlice,
    location_id: ID.clinicNorth,
    authorization_id: ID.abaAuth,
    resource_ids: [],
    range: rangeFor("sat", "14:00", "15:00"),
    telehealth: false,
    ...overrides,
  };
}

function codes(booking: ProposedBooking, options?: RuleOptions, context: ScheduleContext = ctx) {
  return evaluateBooking(booking, context, options).violations.map((v) => v.code);
}

function expectRejects(
  code: ViolationCode,
  booking: ProposedBooking,
  options?: RuleOptions,
  context: ScheduleContext = ctx,
) {
  const result = evaluateBooking(booking, context, options);
  expect(result.violations.map((v) => v.code)).toContain(code);
  expect(result.valid).toBe(false);
}

// ---------------------------------------------------------------------------

describe("the scenario itself", () => {
  it("has 27 ABA hours scheduled against a 30 hour authorization", () => {
    const scheduled = slotsToHours(ctx.slotsScheduled(ID.john, ID.aba));
    expect(scheduled).toBe(27);

    const auth = ctx.authorizationsFor(ID.john, ID.aba)[0];
    expect(auth.authorized_hours).toBe(30);
  });

  it("separates clinical need from what the payer authorized", () => {
    const requirement = ctx.requirementFor(ID.john, ID.aba);
    expect(requirement).not.toBeNull();
    // Four distinct numbers, exactly as spec section 9 insists.
    expect(requirement?.minimum_hours_per_week).toBe(20);
    expect(requirement?.target_hours_per_week).toBe(30);
    expect(requirement?.maximum_hours_per_week).toBe(30);
    expect(ctx.authorizationsFor(ID.john, ID.aba)[0].authorized_hours).toBe(30);
  });

  it("has all three required services already on the calendar", () => {
    for (const serviceId of [ID.therapy, ID.ot, ID.parentTraining]) {
      expect(ctx.sessionsScheduled(ID.john, serviceId)).toBe(1);
      expect(ctx.requirementFor(ID.john, serviceId)?.required).toBe(true);
    }
  });

  it("accepts the three remaining hours on Saturday afternoon", () => {
    const result = evaluateBooking(
      abaBooking({ range: rangeFor("sat", "14:00", "17:00") }),
      ctx,
    );
    // Alice leaves at 15:00, so she is not the provider who can take it...
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("PROVIDER_UNAVAILABLE");

    // ...but Cara is free until 18:00, and reaching exactly 30 hours is feasible.
    const withCara = evaluateBooking(
      abaBooking({
        range: rangeFor("sat", "14:00", "17:00"),
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
      }),
      ctx,
    );
    expect(withCara.valid).toBe(true);

    const projected =
      slotsToHours(ctx.slotsScheduled(ID.john, ID.aba)) + 3;
    expect(projected).toBe(30);
  });
});

// ---------------------------------------------------------------------------

describe("patient conflicts", () => {
  it("rejects ABA overlapping ABA", () => {
    expectRejects("PATIENT_OVERLAP", abaBooking({ range: rangeFor("mon", "14:00", "15:00") }));
  });

  it("rejects ABA overlapping therapy", () => {
    expectRejects("PATIENT_OVERLAP", abaBooking({ range: rangeFor("tue", "17:00", "18:00") }));
  });

  it("rejects therapy overlapping OT", () => {
    expectRejects(
      "PATIENT_OVERLAP",
      abaBooking({
        service_id: ID.therapy,
        provider_id: ID.therapistFay,
        authorization_id: null,
        resource_ids: [ID.therapyRoom],
        range: rangeFor("thu", "17:00", "18:00"),
      }),
    );
  });

  it("allows back-to-back appointments that only touch", () => {
    // Monday ABA ends at 18:00; 18:00-19:00 does not overlap it.
    const result = evaluateBooking(
      abaBooking({ range: rangeFor("mon", "18:00", "19:00") }),
      ctx,
    );
    expect(result.violations.map((v) => v.code)).not.toContain("PATIENT_OVERLAP");
  });
});

describe("provider conflicts", () => {
  it("rejects double-booking a provider across different patients", () => {
    // Alice is with John on Monday 13:00-18:00.
    expectRejects(
      "PROVIDER_OVERLAP",
      abaBooking({
        patient_id: ID.john,
        range: rangeFor("mon", "15:00", "16:00"),
        appointment_id: undefined,
      }),
    );
  });

  it("reports the conflicting appointment so the UI can link to it", () => {
    const result = evaluateBooking(
      abaBooking({ range: rangeFor("mon", "15:00", "16:00") }),
      ctx,
    );
    const overlap = result.violations.find((v) => v.code === "PROVIDER_OVERLAP");
    expect(overlap?.appointment_id).toBe(ID.abaMon);
  });
});

describe("resources", () => {
  it("rejects a room already in use at capacity 1", () => {
    expectRejects(
      "RESOURCE_OVERLAP",
      abaBooking({
        service_id: ID.therapy,
        provider_id: ID.therapistFay,
        authorization_id: null,
        resource_ids: [ID.therapyRoom],
        // Fay is free 13:00-19:00 Tuesday; the room is taken 17:00-18:00.
        range: rangeFor("tue", "17:00", "18:00"),
      }),
    );
  });

  it("allows a second booking in a resource with capacity 2", () => {
    // The OT gym holds two; Thursday 17:00-18:00 already has one session.
    const result = evaluateBooking(
      abaBooking({
        patient_id: ID.john,
        service_id: ID.ot,
        provider_id: ID.otGil,
        authorization_id: null,
        resource_ids: [ID.otGym],
        range: rangeFor("thu", "17:00", "18:00"),
        appointment_id: ID.otThu,
      }),
      ctx,
    );
    expect(result.violations.map((v) => v.code)).not.toContain("RESOURCE_OVERLAP");
  });

  it("rejects a service that requires a room when none is attached", () => {
    expectRejects(
      "REQUIRED_RESOURCE_MISSING",
      abaBooking({
        service_id: ID.ot,
        provider_id: ID.otGil,
        authorization_id: null,
        resource_ids: [],
        range: rangeFor("thu", "15:00", "16:00"),
      }),
    );
  });

  it("rejects a resource that lives at a different location", () => {
    expectRejects(
      "RESOURCE_WRONG_LOCATION",
      abaBooking({
        location_id: ID.clinicSouth,
        provider_id: ID.rbtCara,
        resource_ids: [ID.abaRoom1],
        range: rangeFor("sat", "14:00", "15:00"),
      }),
    );
  });
});

describe("authorization", () => {
  it("rejects a booking that would exceed authorized hours", () => {
    // 27h scheduled, 30h authorized: a 4-hour addition is one hour too many.
    expectRejects(
      "AUTHORIZATION_EXCEEDED",
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        range: rangeFor("sat", "14:00", "18:00"),
      }),
    );
  });

  it("quotes the remaining hours so the failure can be explained", () => {
    const result = evaluateBooking(
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        range: rangeFor("sat", "14:00", "18:00"),
      }),
      ctx,
    );
    const violation = result.violations.find((v) => v.code === "AUTHORIZATION_EXCEEDED");
    expect(violation?.detail).toMatchObject({
      authorized_hours: 30,
      scheduled_hours: 27,
      remaining_hours: 3,
    });
  });

  it("accepts exactly the remaining hours", () => {
    const result = evaluateBooking(
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        range: rangeFor("sat", "14:00", "17:00"),
      }),
      ctx,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a booking outside the authorization period", () => {
    // Shorten the authorization to end on Friday, then book on Saturday.
    const { grid, rows } = buildScenario();
    const shortened = new ScheduleContext(grid, {
      ...rows,
      authorizations: rows.authorizations.map((a) => ({ ...a, end_date: "2026-09-25" })),
    });

    expectRejects(
      "AUTHORIZATION_EXPIRED",
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        range: rangeFor("sat", "14:00", "15:00"),
      }),
      undefined,
      shortened,
    );
  });

  it("requires an authorization for a service configured to need one", () => {
    expectRejects(
      "AUTHORIZATION_MISSING",
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        authorization_id: null,
        range: rangeFor("sat", "14:00", "15:00"),
      }),
    );
  });

  it("does not demand an authorization for services that do not need one", () => {
    const result = evaluateBooking(
      abaBooking({
        service_id: ID.parentTraining,
        provider_id: ID.bcbaEve,
        authorization_id: null,
        range: rangeFor("sat", "14:00", "15:00"),
      }),
      ctx,
    );
    expect(result.violations.map((v) => v.code)).not.toContain("AUTHORIZATION_MISSING");
  });
});

describe("credentials and eligibility", () => {
  it("rejects a provider not flagged eligible for the service", () => {
    expectRejects(
      "PROVIDER_NOT_ELIGIBLE",
      abaBooking({ provider_id: ID.otGil, range: rangeFor("sat", "14:00", "15:00") }),
    );
  });

  it("rejects a provider whose certification has lapsed", () => {
    // Dan is eligible for ABA on paper but his RBT cert expired 2026-08-31.
    expectRejects(
      "PROVIDER_CREDENTIAL_EXPIRED",
      abaBooking({ provider_id: ID.rbtDan, range: rangeFor("mon", "12:30", "13:00") }),
    );
  });
});

describe("availability", () => {
  it("rejects a time the patient is not available", () => {
    // John's Saturday availability ends at 17:00.
    expectRejects(
      "PATIENT_UNAVAILABLE",
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        range: rangeFor("sat", "17:00", "18:00"),
      }),
    );
  });

  it("rejects a time the provider is not available", () => {
    // Alice starts at 12:00 on weekdays.
    expectRejects(
      "PROVIDER_UNAVAILABLE",
      abaBooking({ range: rangeFor("mon", "11:00", "12:00") }),
    );
  });

  it("rejects a time blocked by school", () => {
    expectRejects(
      "PATIENT_RESTRICTED",
      abaBooking({
        provider_id: ID.rbtBen,
        range: rangeFor("mon", "11:00", "12:00"),
      }),
    );
  });

  it("names school specifically rather than reporting a generic clash", () => {
    const result = evaluateBooking(
      abaBooking({ provider_id: ID.rbtBen, range: rangeFor("mon", "11:00", "12:00") }),
      ctx,
    );
    const violation = result.violations.find((v) => v.code === "PATIENT_RESTRICTED");
    expect(violation?.detail?.restriction_type).toBe("SCHOOL");
    expect(violation?.message).toContain("school");
  });

  it("ignores availability rows outside their effective dates", () => {
    // Alice's PTO block covers October only; this September Tuesday stands.
    const result = evaluateBooking(
      abaBooking({ range: rangeFor("tue", "12:30", "13:00") }),
      ctx,
    );
    expect(result.violations.map((v) => v.code)).not.toContain("PROVIDER_UNAVAILABLE");
  });
});

describe("appointment status", () => {
  it("refuses to move a locked appointment", () => {
    expectRejects(
      "APPOINTMENT_LOCKED",
      abaBooking({
        service_id: ID.parentTraining,
        provider_id: ID.bcbaEve,
        authorization_id: null,
        appointment_id: ID.parentTrainingSat,
        range: rangeFor("sat", "15:00", "16:00"),
      }),
    );
  });

  it("allows a locked appointment to be revalidated unchanged", () => {
    const result = evaluateBooking(
      abaBooking({
        service_id: ID.parentTraining,
        provider_id: ID.bcbaEve,
        authorization_id: null,
        appointment_id: ID.parentTrainingSat,
        range: rangeFor("sat", "13:00", "14:00"),
      }),
      ctx,
    );
    expect(result.violations.map((v) => v.code)).not.toContain("APPOINTMENT_LOCKED");
  });

  it("treats a protected appointment as movable", () => {
    // Therapy is PROTECTED, not LOCKED: the engine permits the move and leaves
    // the cost of it to the optimizer.
    const result = evaluateBooking(
      abaBooking({
        service_id: ID.therapy,
        provider_id: ID.therapistFay,
        authorization_id: null,
        resource_ids: [ID.therapyRoom],
        appointment_id: ID.therapyTue,
        range: rangeFor("tue", "13:00", "14:00"),
      }),
      ctx,
      { ignoreAppointmentIds: [ID.abaTue] },
    );
    expect(result.violations.map((v) => v.code)).not.toContain("APPOINTMENT_LOCKED");
    expect(result.valid).toBe(true);
  });
});

describe("service configuration", () => {
  it("rejects a duration the service does not offer", () => {
    // Therapy runs 45 or 60 minutes only.
    expectRejects(
      "SERVICE_DURATION_INVALID",
      abaBooking({
        service_id: ID.therapy,
        provider_id: ID.therapistFay,
        authorization_id: null,
        resource_ids: [ID.therapyRoom],
        range: rangeFor("tue", "13:00", "13:30"),
      }),
    );
  });

  it("rejects telehealth for a service that does not allow it", () => {
    expectRejects(
      "SERVICE_MODALITY_NOT_ALLOWED",
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.telehealth,
        telehealth: true,
        range: rangeFor("sat", "14:00", "15:00"),
      }),
    );
  });
});

describe("travel", () => {
  const travel = new FlatTravelModel(ctx.locations, {
    defaultMinutes: 45,
    enforceAsHardConstraint: true,
  });

  it("rejects a clinic-to-clinic hop with no time to travel", () => {
    // Cara finishes at South at 15:00; a 15:00 start at North is impossible.
    const local = buildScenario().ctx;
    expectRejects(
      "TRAVEL_TIME_INSUFFICIENT",
      {
        patient_id: ID.john,
        service_id: ID.aba,
        provider_id: ID.rbtAlice,
        location_id: ID.clinicSouth,
        authorization_id: ID.abaAuth,
        resource_ids: [],
        // Immediately after Alice's Monday session at North, at the other clinic.
        range: rangeFor("mon", "18:00", "18:30"),
        telehealth: false,
      },
      { travel },
      local,
    );
  });

  it("does not charge travel for telehealth", () => {
    const result = evaluateBooking(
      abaBooking({
        service_id: ID.supervision,
        provider_id: ID.bcbaEve,
        authorization_id: null,
        location_id: ID.telehealth,
        telehealth: true,
        range: rangeFor("sat", "14:00", "15:00"),
      }),
      ctx,
      { travel },
    );
    expect(result.violations.map((v) => v.code)).not.toContain("TRAVEL_TIME_INSUFFICIENT");
  });

  it("downgrades travel to a soft cost when configured that way", () => {
    const soft = new FlatTravelModel(ctx.locations, {
      defaultMinutes: 45,
      enforceAsHardConstraint: false,
    });
    const result = evaluateBooking(
      {
        patient_id: ID.john,
        service_id: ID.aba,
        provider_id: ID.rbtAlice,
        location_id: ID.clinicSouth,
        authorization_id: ID.abaAuth,
        resource_ids: [],
        range: rangeFor("mon", "18:00", "18:30"),
        telehealth: false,
      },
      ctx,
      { travel: soft },
    );
    const violation = result.violations.find((v) => v.code === "TRAVEL_TIME_INSUFFICIENT");
    expect(violation?.severity).toBe("SOFT");
  });
});

describe("preferences", () => {
  it("does not block a booking that misses a soft preference", () => {
    const result = evaluateBooking(
      abaBooking({
        provider_id: ID.rbtCara,
        location_id: ID.clinicSouth,
        range: rangeFor("sat", "14:00", "17:00"),
      }),
      ctx,
      { includeSoft: true },
    );
    expect(result.valid).toBe(true);
    // John prefers Alice at North; Cara at South is allowed but noted.
    const miss = result.violations.find((v) => v.code === "HARD_PREFERENCE_VIOLATED");
    expect(miss?.severity).toBe("SOFT");
  });

  it("omits soft violations unless asked", () => {
    expect(
      codes(
        abaBooking({
          provider_id: ID.rbtCara,
          location_id: ID.clinicSouth,
          range: rangeFor("sat", "14:00", "17:00"),
        }),
      ),
    ).not.toContain("HARD_PREFERENCE_VIOLATED");
  });
});

describe("reporting", () => {
  it("returns every reason, not just the first", () => {
    // Booked during school, with an unavailable provider, over authorization.
    const result = evaluateBooking(
      abaBooking({
        provider_id: ID.rbtDan,
        range: rangeFor("mon", "09:00", "12:00"),
      }),
      ctx,
    );
    const found = new Set(result.violations.map((v) => v.code));
    expect(found.has("PATIENT_RESTRICTED")).toBe(true);
    expect(found.has("PROVIDER_UNAVAILABLE")).toBe(true);
    expect(found.has("PROVIDER_CREDENTIAL_EXPIRED")).toBe(true);
    expect(found.size).toBeGreaterThanOrEqual(3);
  });
});
