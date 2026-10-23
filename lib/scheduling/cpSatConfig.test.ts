import { describe, expect, it } from "vitest";

import { readCpSatConfig } from "./cpSatConfig";

describe("CP-SAT configuration", () => {
  it("is disabled when no solver settings exist", () => {
    expect(readCpSatConfig({}, { allowLocalHttp: false })).toBeNull();
  });

  it("accepts an authenticated HTTPS solver origin", () => {
    expect(readCpSatConfig({
      CP_SAT_SOLVER_URL: "https://solver.example.org",
      CP_SAT_SOLVER_SECRET: "a-secret-with-more-than-24-characters",
      CP_SAT_REQUIRED: "true",
    }, { allowLocalHttp: false })).toMatchObject({
      url: "https://solver.example.org",
      required: true,
      maxCandidates: 4_000,
    });
  });

  it("allows local HTTP only when explicitly enabled", () => {
    const env = {
      CP_SAT_SOLVER_URL: "http://127.0.0.1:8090",
      CP_SAT_SOLVER_SECRET: "a-secret-with-more-than-24-characters",
    };
    expect(readCpSatConfig(env, { allowLocalHttp: true })?.url).toBe("http://127.0.0.1:8090");
    expect(() => readCpSatConfig(env, { allowLocalHttp: false })).toThrow(/HTTPS/);
  });

  it("rejects partial credentials and unsafe bounds", () => {
    expect(() => readCpSatConfig({ CP_SAT_REQUIRED: "true" })).toThrow(/URL/);
    expect(() => readCpSatConfig({
      CP_SAT_SOLVER_URL: "https://solver.example.org",
      CP_SAT_SOLVER_SECRET: "too-short",
    })).toThrow(/24 characters/);
    expect(() => readCpSatConfig({
      CP_SAT_SOLVER_URL: "https://solver.example.org",
      CP_SAT_SOLVER_SECRET: "a-secret-with-more-than-24-characters",
      CP_SAT_MAX_CANDIDATES: "99",
    })).toThrow(/between 100 and 12000/);
  });
});
