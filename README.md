# Baker Street Scheduling

Baker Street Scheduling is a responsive clinical scheduling application built
with Next.js, Supabase Auth, Postgres, and row-level security. It combines a
15-minute scheduling rule engine with deterministic local optimization, an
optional private Python CP-SAT service, and a human approval workflow.

The application is designed for desktop and mobile/PWA use. Seven staff roles
receive permission-based navigation and database-enforced access to the minimum
patient and staff records they need.

## What is implemented

- Email/password sign-in, sign-up, password reset, and administrator-approved
  staff profiles.
- Optional enterprise SAML SSO through Supabase Auth, with fixed same-origin
  callbacks and the same inactive-by-default administrator approval boundary.
- Vendor-neutral FHIR R4 patient bundle export and authenticated EHR capability
  checks; outbound clinical-record writes remain disabled pending client mapping
  and source-of-truth approval.
- FHIR R4 professional Claim draft export, payer/coding readiness diagnostics,
  and a disabled-by-default idempotent submission adapter that refuses
  incomplete drafts.
- Optional, explicitly PHI-approved language-model interpretation for
  low-confidence assistant questions, with tokenization, strict structured
  output validation, and deterministic fallback; the rule engine still answers.
- Patient, provider, care-team, authorization, availability, appointment,
  resource, audit, work-queue, and reporting workflows.
- Administrator-managed service, duration, location, room, and equipment
  configuration with atomic writes, future-booking safeguards, and audit history.
- Consent-aware patient and guardian contacts, appointment reminders, recovery
  outreach, delivery-state tracking, retries, opt-outs, and a mobile-first
  communications queue. A bounded server-only worker supports Twilio SMS and
  SendGrid email with signed receipt webhooks; delivery remains record-only by
  default until both independent live-delivery gates are enabled.
- A separate, read-only guardian portal with verified email-link login,
  scheduler-approved grants, minimal 90-day appointment views, versioned audit
  history, immediate revocation, and automatic revocation when authority changes.
- Ranked availability and conflict checks backed by the same scheduling rules.
- A focused single-service Fill Service analysis with honest lower and upper
  bounds.
- A deterministic multi-service patient-week optimizer that protects required
  care and balances coverage, continuity, visit count, preferences, staff,
  rooms, authorization, and travel.
- An authenticated Google OR-Tools CP-SAT service for global optimization over
  the generated addition candidates, with a deterministic TypeScript fallback,
  strict response validation, and shared-rule revalidation before approval.
- Alternative plan comparison with explicit `TARGETS_MET`, `FEASIBLE`,
  `INFEASIBLE`, and `BOUNDED` outcomes. `BOUNDED` means the safety limit was
  reached; it is not a claim of global optimality.
- Human approval that reloads RLS-scoped data, recomputes the selected plan,
  rejects stale options, and commits additions, an optional one-visit move,
  resources, the optimization result, and audit history in one Postgres
  transaction.
- Explicit reject and defer decisions for generated plans, with stable-plan
  revalidation, follow-up queues, concurrency safety, and audit history.
- Idempotent approvals, so a retried mobile request cannot add the same plan
  twice.
- Database-enforced clinical reduction review. Routine appointment moves stay
  immediate, while a scheduler's edit that would lower a service below its
  weekly target remains unapplied until an assigned clinical supervisor
  approves the exact, stale-protected proposal.
- Planned provider time-off requests with scheduler approval. Approval reuses
  the atomic callout transaction to block the exact window, cancel overlapping
  active visits, and open schedule-recovery work without a second data entry.
- Guarded administrator access management with activation, deactivation,
  clinician-link validation, stale-version protection, last-admin safety, and
  permanent decision reasons.
- PHI-free operational monitoring for failed-login spikes, authorization and
  credential expiry, communication failures/backlogs, optimizer safety limits,
  and push failures, with role-targeted work-queue alerts and an authenticated
  production-monitor endpoint.
- Automatic staff push delivery for new user and role work-queue alerts, with
  private lock-screen payloads, atomic leases, bounded retries, stale-device
  cleanup, and a protected five-minute production worker.
- Installable mobile PWA with PHI-safe offline behavior, complete app artwork,
  an in-app install flow, and disabled-by-default Android/iOS verified-link
  endpoints for client-owned store identities.

The application claims optimality only when CP-SAT proves the complete generated
addition model; truncated/reduced searches and local fallback remain explicitly
`BOUNDED`. When additions alone fall short, the optimizer can compare plans that relocate one
future in-person `FLEXIBLE` visit without changing its service, duration,
authorization, status, or clinical hours. It does not cancel or reduce existing
care.

## Local development

Requirements: Node.js, npm, and a Supabase project for authenticated/live-data
workflows.

```powershell
npm.cmd ci
npm.cmd run dev
```

Open `http://localhost:3000`. Set `USE_SYNTHETIC_DATA=true` only for the
intentional synthetic clinic; never mistake that mode for a production data
connection.

For Supabase-backed use, configure at least:

```text
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
```

Apply every migration under `supabase/migrations` in order. Do not install only
the original schema: later migrations add authentication profiles, care-team
RLS, operational workflows, push subscriptions, schedule recovery,
communications, and atomic optimizer approval.
The service-role key is server-only and is needed only for controlled seed,
administrative jobs, and the communications worker/webhooks; ordinary page
reads use the signed-in user's session. Copy `.env.example` for the complete
communications configuration contract, and follow the communications runbook
before enabling either live-delivery gate.

Mobile installation and verified Android/iOS links are documented in
[`docs/MOBILE_RELEASE.md`](docs/MOBILE_RELEASE.md). Store binaries remain a
client-owned release step because their identities and signing material cannot
be safely substituted.

Optional test-account seeding requires server-only
`SUPABASE_SERVICE_ROLE_KEY` and `TEST_USER_PASSWORD`:

```powershell
npm.cmd run seed:users
```

## Quality checks

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
# From services/cp_sat_solver on Windows, using its virtual environment:
.venv\Scripts\python.exe -m unittest discover -s tests -v
npm.cmd run test:e2e
npx.cmd supabase test db --linked
npm.cmd run build
npm.cmd run verify:role-access
```

The database access suite verifies the seven roles and should be run against a
non-production linked project. See [the production runbook](docs/PRODUCTION_RUNBOOK.md)
for release, rollback, monitoring, and post-deployment checks.

## Key documentation

- [Scheduling engine](docs/ENGINE.md)
- [CP-SAT service](docs/CP_SAT_SOLVER.md)
- [Roles and permissions](docs/ROLES_AND_PERMISSIONS.md)
- [Enterprise SSO](docs/ENTERPRISE_SSO.md)
- [EHR / FHIR integration](docs/EHR_INTEGRATION.md)
- [Guardian portal](docs/GUARDIAN_PORTAL.md)
- [Claims interoperability](docs/CLAIMS.md)
- [Optional LLM assistant](docs/LLM_ASSISTANT.md)
- [Client demonstration guide](docs/CLIENT_DEMO.md)
- [Communications and consent](docs/COMMUNICATIONS.md)
- [Configuration writes](docs/CONFIGURATION.md)
- [Clinical reduction review](docs/CLINICAL_REDUCTIONS.md)
- [Provider time off](docs/TIME_OFF.md)
- [User access management](docs/ACCESS_MANAGEMENT.md)
- [End-to-end testing](docs/TESTING.md)
- [Production runbook](docs/PRODUCTION_RUNBOOK.md)
- [Backup and restore verification](docs/DISASTER_RECOVERY.md)

## Safety model

The optimizer proposes; a permitted staff member decides. Browser input is
never accepted as an approval payload. On approval, the server reconstructs
the plan from current data and the database rechecks the authoritative hard
constraints while holding the relevant locks. Any failure rolls back the whole
transaction, so a plan is committed completely or not at all.
