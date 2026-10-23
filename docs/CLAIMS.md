# Claims and billing interoperability

The authorization role has a Claim Readiness screen for completed visits. It
builds FHIR R4 professional `Claim` drafts and explicitly lists every missing
submission prerequisite: patient and provider identifiers, payer and
authorization reference, approved service billing code, and diagnosis code.

Drafts can be downloaded as a FHIR collection bundle. They contain no clinical
notes or communications. The configured service-code map converts internal
service codes to client-approved CPT/HCPCS (or another code system):

```text
CLAIMS_SERVICE_CODE_MAP_JSON={"ABA_DIRECT":{"system":"http://www.ama-assn.org/go/cpt","code":"97153","display":"Adaptive behavior treatment"}}
```

The repository includes an authenticated FHIR submission client with a stable
payload-derived `Idempotency-Key`, strict readiness check, timeout, and response
validation. It is intentionally not connected to a staff submit button or
worker while prerequisites are missing. Configuration is disabled by default:

```text
CLAIMS_SUBMISSION_ENABLED=false
CLAIMS_FHIR_SUBMISSION_URL=https://clearinghouse.example/fhir/Claim
CLAIMS_FHIR_BEARER_TOKEN=<server-only token>
CLAIMS_SUBMISSION_TIMEOUT_MS=10000
```

Before live submission, the client must supply the clearinghouse/payer choice,
BAA and security approval, patient/member and billing-provider identifier
sources, diagnosis ownership and coding rules, service/modifier/unit mappings,
place-of-service rules, pricing, corrections/void workflows, sandbox fixtures,
idempotency guarantee, and 277/835 rejection/remittance handling. Until those
are approved, the application truthfully produces drafts and readiness gaps—it
does not call them submitted claims.
