import { afterEach, describe, expect, it, vi } from "vitest";

import type { CandidateAppointment } from "../domain/types";
import { FlatTravelModel } from "../rules/travel";
import { ID, buildScenario } from "../testing/scenario";
import { buildCpSatIncompatibilities, optimizePatientWeekWithSolver } from "./cpSat";

function candidate(overrides: Partial<CandidateAppointment> = {}): CandidateAppointment {
  return {
    candidate_id: "candidate-a",
    patient_id: ID.john,
    service_id: ID.aba,
    provider_id: ID.rbtAlice,
    authorization_id: null,
    start_slot: 10,
    duration_slots: 4,
    end_slot: 14,
    location_id: ID.clinicNorth,
    resource_ids: [],
    is_existing: false,
    flexibility: "FLEXIBLE",
    service_priority: 1,
    required_service: true,
    target_service: true,
    objective_values: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CP-SAT adapter", () => {
  it("adds hard travel incompatibilities without exposing locations", () => {
    const { ctx } = buildScenario();
    const travel = new FlatTravelModel(ctx.locations, { defaultMinutes: 30 });
    const candidates = [
      candidate(),
      candidate({ candidate_id: "candidate-b", start_slot: 15, end_slot: 19, location_id: ID.home }),
    ];
    expect(buildCpSatIncompatibilities(candidates, travel)).toEqual([{ left: 0, right: 1 }]);
  });

  it("sends only opaque solver fields and preserves bounded plans", async () => {
    vi.stubEnv("CP_SAT_SOLVER_URL", "https://solver.example.org");
    vi.stubEnv("CP_SAT_SOLVER_SECRET", "a-secret-with-more-than-24-characters");
    let payload: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      const solverCandidates = payload.candidates as { candidate_id: string }[];
      return new Response(JSON.stringify({
        version: 1,
        status: "OPTIMAL",
        plans: [{
          strategy: "BALANCED",
          candidate_ids: [solverCandidates[0].candidate_id],
          optimal: true,
        }],
        runtime_ms: 3,
        branches: 0,
        conflicts: 0,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { ctx } = buildScenario();
    const result = await optimizePatientWeekWithSolver(ctx, {
      patient_id: ID.john,
      target_hours: { [ID.aba]: 40 },
      travel: new FlatTravelModel(ctx.locations),
    });

    expect(result.meta.engine).toBe("PYTHON_CP_SAT");
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans.some((plan) => plan.id.startsWith("cpsat_"))).toBe(true);
    expect(payload).not.toBeNull();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("patient_id");
    expect(serialized).not.toContain("service_name");
    expect(serialized).not.toContain("location_id");
    expect(serialized).not.toContain("resource_ids");
    expect(serialized).not.toContain(ID.clinicNorth);
    expect(serialized).not.toContain(ID.clinicSouth);
    expect(serialized).not.toContain(ID.abaRoom1);
  });
});
