import { createHash } from "node:crypto";

import type { BillingCodeMapping } from "./config";

export type ClaimGap =
  | "PATIENT_IDENTIFIER"
  | "PROVIDER_IDENTIFIER"
  | "PAYER"
  | "AUTHORIZATION_REFERENCE"
  | "SERVICE_BILLING_CODE"
  | "DIAGNOSIS_CODE";

export interface ClaimDraftInput {
  appointmentId: string;
  patientId: string;
  patientExternalId: string | null;
  providerId: string | null;
  providerExternalId: string | null;
  serviceCode: string;
  serviceName: string;
  billingCode: BillingCodeMapping | null;
  payer: string | null;
  authorizationReference: string | null;
  diagnosisCode: string | null;
  startTime: string;
  endTime: string;
}

export interface ClaimDraft {
  appointmentId: string;
  idempotencyKey: string;
  ready: boolean;
  gaps: ClaimGap[];
  resource: Record<string, unknown>;
}

export function buildClaimDraft(input: ClaimDraftInput): ClaimDraft {
  const gaps: ClaimGap[] = [];
  if (!input.patientExternalId) gaps.push("PATIENT_IDENTIFIER");
  if (!input.providerExternalId) gaps.push("PROVIDER_IDENTIFIER");
  if (!input.payer) gaps.push("PAYER");
  if (!input.authorizationReference) gaps.push("AUTHORIZATION_REFERENCE");
  if (!input.billingCode) gaps.push("SERVICE_BILLING_CODE");
  if (!input.diagnosisCode) gaps.push("DIAGNOSIS_CODE");
  const start = new Date(input.startTime);
  const end = new Date(input.endTime);
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  const idempotencyKey = `claim_${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
  const resource: Record<string, unknown> = {
    resourceType: "Claim",
    id: input.appointmentId,
    status: "draft",
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] },
    use: "claim",
    created: new Date(input.endTime).toISOString(),
    patient: { reference: `Patient/${input.patientId}`, ...(input.patientExternalId ? { identifier: { value: input.patientExternalId } } : {}) },
    provider: input.providerId ? { reference: `Practitioner/${input.providerId}`, ...(input.providerExternalId ? { identifier: { value: input.providerExternalId } } : {}) } : undefined,
    insurer: input.payer ? { display: input.payer } : undefined,
    insurance: [{ sequence: 1, focal: true, coverage: { display: input.authorizationReference ?? "Authorization mapping required" } }],
    diagnosis: input.diagnosisCode ? [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: input.diagnosisCode }] } }] : [],
    item: [{
      sequence: 1,
      servicedDate: input.startTime.slice(0, 10),
      productOrService: input.billingCode
        ? { coding: [input.billingCode] }
        : { text: `${input.serviceCode} — ${input.serviceName}; billing mapping required` },
      quantity: { value: minutes, unit: "minutes", system: "http://unitsofmeasure.org", code: "min" },
    }],
    extension: [{ url: "https://baker-street.example/fhir/StructureDefinition/source-appointment", valueReference: { reference: `Appointment/${input.appointmentId}` } }],
  };
  return { appointmentId: input.appointmentId, idempotencyKey, ready: gaps.length === 0, gaps, resource };
}

export function claimDraftBundle(drafts: ClaimDraft[]) {
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: new Date().toISOString(),
    total: drafts.length,
    entry: drafts.map((draft) => ({
      fullUrl: `urn:uuid:${draft.appointmentId}`,
      resource: draft.resource,
      search: { mode: draft.ready ? "match" : "outcome", score: draft.ready ? 1 : 0 },
    })),
  };
}
