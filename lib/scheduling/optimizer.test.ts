import { describe, expect, it } from "vitest";

import { overlaps } from "../domain/slots";
import { evaluateBooking } from "../rules/engine";
import { FlatTravelModel } from "../rules/travel";
import { ID, buildScenario } from "../testing/scenario";
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
});
