import { describe, expect, it } from "vitest";

import { buildClaimDraft } from "./fhir";

const complete = () => ({
  appointmentId: "appointment-1", patientId: "patient-1", patientExternalId: "MRN-1",
  providerId: "provider-1", providerExternalId: "NPI-1", serviceCode: "ABA_DIRECT",
  serviceName: "ABA Direct", billingCode: { system: "http://www.ama-assn.org/go/cpt", code: "97153" },
  payer: "Example Payer", authorizationReference: "AUTH-1", diagnosisCode: "F84.0",
  startTime: "2026-10-23T14:00:00Z", endTime: "2026-10-23T15:00:00Z",
});

describe("FHIR claim drafts", () => {
  it("builds a deterministic ready professional claim", () => {
    const first = buildClaimDraft(complete());
    const second = buildClaimDraft(complete());
    expect(first.ready).toBe(true);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.resource).toMatchObject({ resourceType: "Claim", status: "draft", use: "claim" });
  });

  it("enumerates every unsafe submission gap", () => {
    const draft = buildClaimDraft({ ...complete(), patientExternalId: null, providerExternalId: null, payer: null, authorizationReference: null, billingCode: null, diagnosisCode: null });
    expect(draft.ready).toBe(false);
    expect(draft.gaps).toHaveLength(6);
  });
});
