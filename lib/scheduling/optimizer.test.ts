import { describe, expect, it } from "vitest";

import { overlaps, SlotGrid } from "../domain/slots";
import { ScheduleContext } from "../rules/context";
import { evaluateBooking } from "../rules/engine";
import { FlatTravelModel } from "../rules/travel";
import { ID, TZ, WEEK_START, buildScenario, buildScenarioRows } from "../testing/scenario";
import { candidateToAppointment, generateCandidates } from "./candidates";
import { optimizePatientWeek } from "./optimizer";

describe("multi-service patient-week optimizer", () => {
  it("reaches the ABA target while preserving every required service", () => {
    const { ctx } = buildScenario();
    const result = optimizePatientWeek(ctx, {
      patient_id: ID.john,
      travel: new FlatTravelModel(ctx.locations),
    });

    expect(result.status).toBe("TARGETS_MET");
    expect(result.plans.length).toBeGreaterThan(0);
    const best = result.plans[0];
    expect(best.required_services_met).toBe(true);
    expect(best.service_metrics.find((metric) => metric.service_id === ID.aba)).toMatchObject({
      current_hours: 27,
      added_hours: 3,
      projected_hours: 30,
      target_met: true,
    });
    expect(best.appointments.reduce((hours, row) => hours + row.duration_slots / 4, 0)).toBe(3);
  });

  it("returns plans whose appointments remain legal when proved together", () => {
    const { ctx } = buildScenario();
    const travel = new FlatTravelModel(ctx.locations);
    const result = optimizePatientWeek(ctx, { patient_id: ID.john, travel });
    let working = ctx;

    for (const candidate of result.plans[0].appointments) {
      const proof = evaluateBooking(
        {
          patient_id: candidate.patient_id,
          service_id: candidate.service_id,
          provider_id: candidate.provider_id,
          location_id: candidate.location_id,
          authorization_id: candidate.authorization_id,
          resource_ids: candidate.resource_ids,
          range: { startSlot: candidate.start_slot, endSlot: candidate.end_slot },
          telehealth: false,
        },
        working,
        { travel, includeSoft: false },
      );
      expect(proof.violations.filter((row) => row.severity === "HARD")).toEqual([]);
      working = working.withExtraAppointments(
        [candidateToAppointment(candidate, working)],
        candidate.resource_ids.map((resource_id) => ({
          appointment_id: candidate.candidate_id,
          resource_id,
        })),
      );
    }
  });

  it("is deterministic so stale approval IDs cannot select a different plan", () => {
    const { ctx } = buildScenario();
    const request = { patient_id: ID.john, max_solutions: 4 } as const;
    const first = optimizePatientWeek(ctx, request);
    const second = optimizePatientWeek(ctx, request);

    expect(second.plans.map((plan) => plan.id)).toEqual(first.plans.map((plan) => plan.id));
    expect(second.plans.map((plan) => plan.appointments.map((row) => row.candidate_id))).toEqual(
      first.plans.map((plan) => plan.appointments.map((row) => row.candidate_id)),
    );
  });

  it("never exceeds authorization even when an override asks for more", () => {
    const { ctx } = buildScenario();
    const result = optimizePatientWeek(ctx, {
      patient_id: ID.john,
      target_hours: { [ID.aba]: 40 },
    });
    const metric = result.plans[0]?.service_metrics.find((row) => row.service_id === ID.aba);

    expect(metric?.projected_hours).toBeLessThanOrEqual(30);
    expect(result.explanations.some((row) => row.code === "AUTHORIZATION_CEILING")).toBe(true);
  });

  it("candidate generation never ignores locked or out-of-scope care", () => {
    const { ctx } = buildScenario();
    const fixed = (ctx.appointmentsByPatient.get(ID.john) ?? []).filter(
      (appointment) => appointment.service_id !== ID.aba || appointment.scheduling_flexibility === "LOCKED",
    );
    const candidates = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      includeExisting: true,
    }).candidates.filter((candidate) => !candidate.is_existing);

    expect(
      candidates.some((candidate) =>
        fixed.some((appointment) =>
          overlaps(
            { startSlot: candidate.start_slot, endSlot: candidate.end_slot },
            appointment.range,
          ),
        ),
      ),
    ).toBe(false);
  });

  it("moves one flexible visit only when that unlocks better clinical coverage", () => {
    const rows = buildScenarioRows();
    const source = rows.appointments.find((appointment) => appointment.id === ID.abaWed)!;
    const oneHourEnd = new Date(new Date(source.start_time).getTime() + 60 * 60_000).toISOString();
    rows.appointments = [{ ...source, end_time: oneHourEnd }];
    rows.appointmentResources = [];
    rows.serviceDurations = rows.serviceDurations.filter(
      (duration) =>
        (duration.service_id === ID.aba || duration.service_id === ID.supervision) &&
        duration.duration_minutes === 60,
    );
    rows.providerAvailability = rows.providerAvailability.filter(
      (availability) =>
        (availability.provider_id === ID.rbtAlice && [1, 3].includes(availability.day_of_week)) ||
        availability.provider_id === ID.bcbaEve,
    ).map((availability) =>
      availability.provider_id === ID.bcbaEve
        ? { ...availability, day_of_week: 3 as const, start_time: "13:00", end_time: "14:00" }
        : availability,
    );
    rows.patientServiceRequirements = [
      {
        ...rows.patientServiceRequirements.find((requirement) => requirement.service_id === ID.aba)!,
        minimum_hours_per_week: 1,
        maximum_hours_per_week: 2,
        target_hours_per_week: 1,
      },
      {
        id: "psr-supervision-rescue",
        patient_id: ID.john,
        service_id: ID.supervision,
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
    ];
    const ctx = new ScheduleContext(SlotGrid.week(WEEK_START, TZ), rows);

    const additionsOnly = optimizePatientWeek(ctx, {
      patient_id: ID.john,
      allow_moves: false,
      start_step_slots: 1,
    });
    const withMove = optimizePatientWeek(ctx, {
      patient_id: ID.john,
      max_move_sources: 1,
      max_move_destinations: 2,
      start_step_slots: 1,
    });
    const afterVisitStarted = optimizePatientWeek(ctx, {
      patient_id: ID.john,
      move_not_before: new Date("2026-09-28T00:00:00Z"),
      start_step_slots: 1,
    });

    expect(additionsOnly.plans[0]?.required_services_met).not.toBe(true);
    expect(withMove.plans[0]).toMatchObject({
      required_services_met: true,
      targets_met: 2,
    });
    expect(withMove.plans[0].moves).toHaveLength(1);
    expect(withMove.plans[0].moves[0]).toMatchObject({
      appointment_id: ID.abaWed,
      service_id: ID.aba,
      flexibility: "FLEXIBLE",
    });
    expect(withMove.plans[0].appointments).toHaveLength(1);
    expect(withMove.plans[0].appointments[0].service_id).toBe(ID.supervision);
    expect(afterVisitStarted.plans.every((plan) => plan.moves.length === 0)).toBe(true);
  });
});
