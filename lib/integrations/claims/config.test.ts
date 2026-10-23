import { describe, expect, it } from "vitest";

import { readClaimsConfig } from "./config";

describe("claims adapter configuration", () => {
  it("keeps submission disabled by default while accepting mappings", () => {
    expect(readClaimsConfig({
      CLAIMS_SERVICE_CODE_MAP_JSON: JSON.stringify({ ABA_DIRECT: { system: "http://www.ama-assn.org/go/cpt", code: "97153" } }),
    })).toMatchObject({ serviceCodes: { ABA_DIRECT: { code: "97153" } }, submission: null });
  });

  it("requires an authenticated HTTPS endpoint for live submission", () => {
    expect(() => readClaimsConfig({ CLAIMS_SUBMISSION_ENABLED: "true", CLAIMS_FHIR_SUBMISSION_URL: "http://payer.example/Claim" })).toThrow(/HTTPS/);
    expect(readClaimsConfig({
      CLAIMS_SUBMISSION_ENABLED: "true",
      CLAIMS_FHIR_SUBMISSION_URL: "https://payer.example/fhir/Claim",
      CLAIMS_FHIR_BEARER_TOKEN: "a-submission-token-with-24-characters",
    }).submission?.url).toBe("https://payer.example/fhir/Claim");
  });
});
