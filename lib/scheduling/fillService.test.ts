/**
 * The acceptance question (spec sections 70, 77), answered without a solver:
 *
 *   "Get this patient as close to 30 ABA hours as possible while preserving
 *    the required services."
 */

import { describe, expect, it } from "vitest";

import { slotsToHours } from "../domain/slots";
import { ID, buildScenario } from "../testing/scenario";
import { generateCandidates } from "./candidates";
import { analyseFillService } from "./fillService";

describe("candidate generation", () => {
  it("produces candidates that are all individually legal", () => {
    const { ctx } = buildScenario();
    const result = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      includeExisting: false,
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);

    // Never the provider whose credential lapsed.
    expect(result.candidates.some((c) => c.provider_id === ID.rbtDan)).toBe(false);
    // Never during school hours: Monday 08:30-12:30 is slots 34-50.
    const mondaySchool = result.candidates.filter(
      (c) => c.start_slot >= 34 && c.start_slot < 50,
    );
    expect(mondaySchool).toHaveLength(0);
  });

  it("keeps the tally of why candidates were rejected", () => {
    const { ctx } = buildScenario();
    const result = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      includeExisting: false,
    });

    expect(result.rejected).toBeGreaterThan(0);
    // Section 67 needs reasons, not just a count.
    expect(Object.keys(result.rejectionsByCode).length).toBeGreaterThan(0);
  });

  it("includes existing appointments so the solver can choose to keep them", () => {
    const { ctx } = buildScenario();
    const result = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      includeExisting: true,
    });

    const existing = result.candidates.filter((c) => c.is_existing);
    expect(existing).toHaveLength(6); // the six ABA sessions already booked
    expect(existing.every((c) => c.candidate_id.startsWith("existing:"))).toBe(true);
  });

  it("carries the flags the solver's objectives will read", () => {
    const { ctx } = buildScenario();
    const [candidate] = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      target_service_id: ID.aba,
      includeExisting: false,
    }).candidates;

    expect(candidate.target_service).toBe(true);
    expect(candidate.required_service).toBe(true);
    expect(candidate.objective_values.hours).toBeGreaterThan(0);
  });

  it("thins the candidate set when the start step is widened", () => {
    const { ctx } = buildScenario();
    const fine = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      includeExisting: false,
      startStepSlots: 1,
    });
    const coarse = generateCandidates(ctx, {
      patient_id: ID.john,
      service_ids: [ID.aba],
      includeExisting: false,
      startStepSlots: 4, // hourly starts only
    });

    expect(coarse.candidates.length).toBeLessThan(fine.candidates.length);
  });
});

describe("fill service — the acceptance scenario", () => {
  const { ctx } = buildScenario();
  const analysis = analyseFillService(ctx, {
    patient_id: ID.john,
    service_id: ID.aba,
    target_hours: 30,
  });

  it("reads the current position correctly", () => {
    expect(analysis.current_hours).toBe(27);
    expect(analysis.authorized_hours).toBe(30);
    expect(analysis.remaining_authorization).toBe(3);
    expect(analysis.target_hours).toBe(30);
  });

  it("reaches exactly 30 hours", () => {
    expect(analysis.achievable_additional_hours).toBe(3);
    expect(analysis.projected_hours).toBe(30);
  });

  it("knows the answer is exact without needing the solver", () => {
    // Greedy met the upper bound, so no arrangement can do better.
    expect(analysis.upper_bound_additional_hours).toBe(3);
    expect(analysis.exact).toBe(true);
    expect(analysis.limiting_factors).toHaveLength(0);
  });

  it("proposes real appointments that do not disturb the required services", () => {
    expect(analysis.proposed.length).toBeGreaterThan(0);

    const addedHours = analysis.proposed.reduce(
      (total, c) => total + slotsToHours(c.duration_slots),
      0,
    );
    expect(addedHours).toBe(3);

    // Therapy, OT and parent training are all still exactly where they were.
    for (const serviceId of [ID.therapy, ID.ot, ID.parentTraining]) {
      expect(ctx.sessionsScheduled(ID.john, serviceId)).toBe(1);
      expect(analysis.proposed.some((c) => c.service_id === serviceId)).toBe(false);
    }
  });

  it("puts the added time in the Saturday afternoon gap", () => {
    // Saturday is horizon day 5; 14:00 is slot 5*96 + 56 = 536.
    for (const candidate of analysis.proposed) {
      expect(candidate.start_slot).toBeGreaterThanOrEqual(536);
      expect(candidate.end_slot).toBeLessThanOrEqual(5 * 96 + 68); // 17:00
    }
  });
});

describe("fill service — when the target is out of reach", () => {
  it("explains a shortfall instead of just failing", () => {
    const { ctx } = buildScenario();
    // Ask for 40 hours against a 30-hour authorization.
    const analysis = analyseFillService(ctx, {
      patient_id: ID.john,
      service_id: ID.aba,
      target_hours: 40,
    });

    expect(analysis.projected_hours).toBeLessThan(40);
    expect(analysis.limiting_factors.length).toBeGreaterThan(0);

    const codes = analysis.limiting_factors.map((f) => f.code);
    expect(codes).toContain("AUTHORIZATION_EXHAUSTED");

    // The binding constraint leads: 3h of authorization is the tightest
    // number, so it must come before context like "school" or "protected".
    expect(codes[0]).toBe("AUTHORIZATION_EXHAUSTED");
    expect(codes[codes.length - 1]).toBe("BLOCKED_BY_RESTRICTION");

    const authFactor = analysis.limiting_factors.find(
      (f) => f.code === "AUTHORIZATION_EXHAUSTED",
    );
    expect(authFactor?.hours).toBe(3);
    expect(authFactor?.message).toMatch(/3h of authorization remain/);
  });

  it("names school and the protected services among the limits", () => {
    const { ctx } = buildScenario();
    const analysis = analyseFillService(ctx, {
      patient_id: ID.john,
      service_id: ID.aba,
      target_hours: 40,
    });

    const codes = analysis.limiting_factors.map((f) => f.code);
    expect(codes).toContain("BLOCKED_BY_RESTRICTION");
    expect(codes).toContain("BLOCKED_BY_PROTECTED");

    const restriction = analysis.limiting_factors.find(
      (f) => f.code === "BLOCKED_BY_RESTRICTION",
    );
    expect(restriction?.message).toContain("school");
  });

  it("reports nothing to do when already at target", () => {
    const { ctx } = buildScenario();
    const analysis = analyseFillService(ctx, {
      patient_id: ID.john,
      service_id: ID.aba,
      target_hours: 27,
    });

    expect(analysis.achievable_additional_hours).toBe(0);
    expect(analysis.proposed).toHaveLength(0);
    expect(analysis.limiting_factors).toHaveLength(0);
  });

  it("never exceeds the authorization even when asked to", () => {
    const { ctx } = buildScenario();
    const analysis = analyseFillService(ctx, {
      patient_id: ID.john,
      service_id: ID.aba,
      target_hours: 100,
    });

    expect(analysis.projected_hours).toBeLessThanOrEqual(30);
  });
});

describe("fill service — a different service entirely", () => {
  it("works for parent training without any ABA-specific handling", () => {
    const { ctx } = buildScenario();
    const analysis = analyseFillService(ctx, {
      patient_id: ID.john,
      service_id: ID.parentTraining,
      target_hours: 2,
    });

    expect(analysis.service_name).toBe("Parent Training");
    expect(analysis.current_hours).toBe(1);
    // Parent training needs no authorization, so that ceiling does not apply.
    expect(analysis.authorized_hours).toBeNull();
    expect(analysis.achievable_additional_hours).toBeGreaterThan(0);
  });
});
