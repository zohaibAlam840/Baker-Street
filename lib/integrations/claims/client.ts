import { readClaimsConfig } from "./config";
import type { ClaimDraft } from "./fhir";

export async function submitFhirClaim(draft: ClaimDraft) {
  const config = readClaimsConfig();
  if (!config.submission) throw new Error("CLAIMS_SUBMISSION_DISABLED");
  if (!draft.ready) throw new Error("CLAIM_NOT_READY");
  const response = await fetch(config.submission.url, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${config.submission.token}`,
      "content-type": "application/fhir+json",
      accept: "application/fhir+json",
      "idempotency-key": draft.idempotencyKey,
    },
    body: JSON.stringify(draft.resource),
    signal: AbortSignal.timeout(config.submission.timeoutMs),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(`CLAIMS_HTTP_${response.status}`);
  if (!body || !["Claim", "ClaimResponse", "Bundle"].includes(String(body.resourceType))) {
    throw new Error("CLAIMS_RESPONSE_INVALID");
  }
  return { resourceType: String(body.resourceType), id: typeof body.id === "string" ? body.id : null };
}
