import { describe, expect, it } from "vitest";

import { readEhrConfig } from "./config";

describe("EHR FHIR configuration", () => {
  it("is disabled by default", () => expect(readEhrConfig({})).toBeNull());

  it("accepts client-credential configuration", () => {
    expect(readEhrConfig({
      EHR_INTEGRATION_ENABLED: "true",
      EHR_FHIR_BASE_URL: "https://ehr.example.org/fhir/r4",
      EHR_FHIR_AUTH_MODE: "OAUTH2_CLIENT_CREDENTIALS",
      EHR_FHIR_TOKEN_URL: "https://ehr.example.org/oauth/token",
      EHR_FHIR_CLIENT_ID: "scheduler-client",
      EHR_FHIR_CLIENT_SECRET: "a-client-secret-with-enough-entropy",
      EHR_FHIR_SCOPE: "system/Patient.read",
    })).toMatchObject({
      baseUrl: "https://ehr.example.org/fhir/r4",
      auth: { mode: "OAUTH2_CLIENT_CREDENTIALS", clientId: "scheduler-client" },
    });
  });

  it("rejects insecure endpoints and incomplete secrets", () => {
    expect(() => readEhrConfig({
      EHR_INTEGRATION_ENABLED: "true",
      EHR_FHIR_BASE_URL: "http://ehr.example.org/fhir",
    })).toThrow(/HTTPS/);
    expect(() => readEhrConfig({
      EHR_INTEGRATION_ENABLED: "true",
      EHR_FHIR_BASE_URL: "https://ehr.example.org/fhir",
      EHR_FHIR_AUTH_MODE: "BEARER",
      EHR_FHIR_BEARER_TOKEN: "short",
    })).toThrow(/16 characters/);
  });
});
