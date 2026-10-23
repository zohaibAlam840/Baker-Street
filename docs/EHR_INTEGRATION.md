# EHR / FHIR integration

The application now exposes a vendor-neutral HL7 FHIR R4 boundary without
assuming which EHR the client uses.

- A signed-in staff member with patient-schedule permission can download an
  RLS-scoped patient `Bundle` from the patient screen. It contains `Patient`,
  `Practitioner`, `Location`, `Coverage`, and `Appointment` resources. Notes,
  communications, audit events, and unrelated patients are excluded.
- Administrators can call `/api/integrations/ehr/capability` to validate a
  configured server's `CapabilityStatement`. The response exposes status,
  supported FHIR version, and software name—not credentials or endpoint URLs.
- Static bearer and OAuth 2.0 client-credential authentication are supported.
  Tokens and client secrets are server-only and never logged.

Configure an approved endpoint only after a BAA/security review:

```text
EHR_INTEGRATION_ENABLED=true
EHR_FHIR_BASE_URL=https://vendor.example/fhir/r4
EHR_FHIR_AUTH_MODE=OAUTH2_CLIENT_CREDENTIALS
EHR_FHIR_TOKEN_URL=https://vendor.example/oauth/token
EHR_FHIR_CLIENT_ID=...
EHR_FHIR_CLIENT_SECRET=...
EHR_FHIR_SCOPE=system/Patient.read system/Appointment.read
EHR_FHIR_TIMEOUT_MS=8000
```

Outbound create/update is intentionally not activated by generic credentials.
The client must still choose the EHR, approve source-of-truth ownership, provide
identifier namespaces and code mappings, define conflict/retry rules, approve
write scopes, and supply a sandbox. Those decisions change clinical records and
cannot safely be guessed by the application.
