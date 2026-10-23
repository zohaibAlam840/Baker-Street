# Production runbook

## Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_SITE_URL` (the exact public HTTPS origin)
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (a monitored `mailto:` address)
- `SCHEDULING_TIMEZONE` (an IANA zone, for example `America/New_York`)
- `RELEASE_SHA` when the hosting platform does not supply `VERCEL_GIT_COMMIT_SHA`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only operational monitoring access)
- `CRON_SECRET` (at least 16 random characters)

The live communications worker additionally requires
`COMMUNICATIONS_PUBLIC_BASE_URL`, `COMMUNICATIONS_DELIVERY_ENABLED`, and a
complete Twilio and/or SendGrid
configuration from `.env.example`. Webhook handlers require the corresponding
provider verification secret even when the worker is temporarily disabled.
The staff push worker uses the required VAPID keys and supports optional
`PUSH_DELIVERY_BATCH_SIZE` and `PUSH_DELIVERY_CONCURRENCY` bounds from
`.env.example`.

The optional CP-SAT worker requires `CP_SAT_SOLVER_URL` and the matching
server-only `CP_SAT_SOLVER_SECRET`. Keep `CP_SAT_REQUIRED=false` until private
HTTPS ingress, multiple instances, health monitoring, and secret rotation have
been exercised in staging. Follow [the solver runbook](CP_SAT_SOLVER.md).

Never expose the service-role key to the browser. It is only needed for controlled seed and administrative jobs.
`USE_SYNTHETIC_DATA` must be absent or `false` in production.

## Release gate

Run these commands before every deployment:

```powershell
npm.cmd ci
npm.cmd audit --omit=dev --audit-level=high
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
python -m pip install --requirement services/cp_sat_solver/requirements.txt
npm.cmd run test:solver
npm.cmd run test:e2e
npx.cmd supabase db push --linked --dry-run
npx.cmd supabase test db --linked
npm.cmd run build
npm.cmd run verify:role-access
```

Review the dry-run migration list before applying it. Deploy every file under
`supabase/migrations` in order; the application requires the role/RLS,
operational-workflow, busy-interval, and optimizer-approval migrations, not
only the original schema. Apply and validate migrations in a production-like
staging project before production.

The repository includes `Quality and security`, `Deploy staging`, and manually
approved `Deploy production` GitHub Actions workflows. Configure `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, and `CRON_SECRET` as
environment-scoped GitHub secrets. `CRON_SECRET` must match the protected
runtime value and contain at least 16 random characters. Configure other
runtime application secrets in Vercel rather than passing private values
through the production workflow.

After deployment, run `DEPLOYMENT_URL=https://example.org npm run verify:deployment`.
Set `EXPECTED_RELEASE_SHA` to the commit being promoted. The verifier checks the
health and schema contract, release identity, non-cacheable health response,
login shell, CSP and browser security headers, framework-header suppression, and
the anonymous redirect from `/dashboard` to same-origin `/login`.

## Staging deployment and promotion

Use a separate Supabase project and the GitHub `staging` environment. Never put
production project references, service-role keys, test passwords, or patient data
in the staging environment. Staging requires the deployment secrets above plus
`SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_PASSWORD`, and the application values
validated by `npm run verify:environment -- staging`.
If Vercel Deployment Protection is enabled, also configure the staging-only
`VERCEL_AUTOMATION_BYPASS_SECRET`; the verifier and Playwright send it as a
header, and it must never be exposed through a `NEXT_PUBLIC_` variable.

The staging workflow validates code, previews migrations, applies them, runs the
database policy suite, refreshes deterministic role accounts, deploys a Vercel
preview, verifies the exact release, and runs the public/mobile and seven-role
browser tests against the deployed URL. Promote only the exact commit that passed
this workflow. Production remains a separately approved GitHub environment and
does not create test users or run mutation fixtures.

## Rollback policy

Application rollback means redeploying the last known-good commit and verifying
its release SHA and health contract. Database migrations are forward-only: do not
delete migration-history rows or run destructive down migrations during an
incident. Schema changes must use expand/contract compatibility so the prior app
can continue operating; if a migration causes a problem, deploy a reviewed
forward-fix migration. Record the failed release, rollback release, timestamps,
operator, health result, and any affected workflows in the incident log.

The deployment platform should poll `GET /api/health`. A `503` means the
application cannot reach Supabase Auth, the database does not expose the required
schema version, or the deployed Vercel runtime fails the environment contract.
The endpoint exposes only an aggregate configuration status, never missing names
or secret values, and that release should not receive traffic.

## Communications release checks

New environments begin in `RECORD_ONLY` delivery mode. Keep that mode for the
first release and verify contact authorization, relationship dates, consent,
quiet hours, appointment/recovery source versions, role scoping, cancellation,
and retry behavior before connecting a provider.

The included worker at `GET /api/communications/deliver` must be invoked with
`Authorization: Bearer $CRON_SECRET`. It uses only service-role communication
RPCs, claims an opaque lease, calls the prepare RPC immediately before sending,
and records outcomes and provider receipts by idempotent IDs. Never log message
bodies or destinations. Both webhook routes validate provider signatures before
calling receipt RPCs. A delayed failure must never overwrite a delivered state;
an opt-out or complaint must revoke the channel and cancel future actionable
jobs. Register a recurring scheduler only after the staging matrix in
`docs/COMMUNICATIONS.md` passes and both live-delivery gates are intentionally
enabled.

Run the seven-role read-only verification after applying the migration. Run the
full pgTAP suite and mutation scenarios against staging, not production.

## Staff push release checks

The protected `GET /api/push/deliver` worker converts unread user and role
work-queue notifications into per-device leased deliveries. Invoke it every
five minutes with `Authorization: Bearer $CRON_SECRET`; the included
`Deliver push notifications` workflow does this when `PRODUCTION_URL` and
`CRON_SECRET` are configured. Overlapping invocations use row locks and cannot
claim the same delivery. An expired lease is retried with bounded exponential
backoff, and a subscription rejected with HTTP 400, 404, or 410 is removed.

Before launch in staging:

1. Enable notifications on two browsers for the same active test account and
   confirm the settings test reaches both devices.
2. Create one user-targeted and one role-targeted work-queue notification after
   the devices subscribed, then invoke `/api/push/deliver` with the cron secret.
3. Confirm each device receives one generic alert linking to `/notifications`.
   Patient names, services, appointment details, and notification body text
   must not appear in the Web Push payload or on the lock screen.
4. Invoke the worker again and confirm accepted deliveries are not resent.
5. Disable one browser subscription and confirm a later rejection removes only
   that stale subscription while the other device continues receiving alerts.
6. Confirm anonymous and ordinary authenticated requests to the worker return
   HTTP 401, and that `push_notification_deliveries` cannot be read or changed
   through an authenticated browser database session.

Web Push reports provider acceptance, not device-display receipts. The ledger
therefore records `ACCEPTED` rather than claiming the user saw the alert; the
secure in-app work queue remains the source of truth.

## Optimizer and atomic-approval release checks

Run mutation checks in a production-like staging project, never by creating
test patient data in production.

1. Confirm the approval RPC is installed with the expected signature:

   ```sql
   select to_regprocedure(
     'public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)'
   );
   ```

2. Sign in as a Scheduler and as a Clinical supervisor. Build a patient-week
   plan, confirm the displayed week/timezone and service projections, enter a
   meaningful reason, and approve it.
3. Verify that the same transaction created the optimization request,
   appointments, required resource links, and linked audit entry. Verify the
   actor, approval reason, patient, week, and plan ID.
4. Retry the same approval. It must report that the plan was already approved
   and add no appointments, resource rows, or duplicate audit history.
5. Exercise rollback: build another plan, then consume its authorization or
   room/provider slot before approval. Approval must reject the stale/live
   conflict and the counts for optimization requests, appointments,
   appointment resources, and audit entries must remain unchanged.
6. Sign in as Provider, Authorization, Operations, Admin, and Compliance test
   accounts and confirm none can invoke approval. Confirm a Clinical user also
   cannot optimize a patient outside their active care-team scope.

In production, use an existing authorized account only for a read-only plan
generation smoke test. Check logs for a bounded-search disclosure or a valid
plan response, but do not approve a synthetic/test plan.

## Supabase production controls

1. Use a paid Supabase organization covered by the required healthcare agreement.
2. Enable point-in-time recovery and confirm the retention window with the organization owner.
3. Enable database network restrictions if the hosting egress addresses are stable.
4. Rotate the database password, service-role key, and VAPID keys before launch.
5. Configure Auth redirect URLs for the production hostname only.
6. Keep email confirmation disabled only if account approval remains mandatory.

## Clinical reduction drill

Before launch, use a non-production patient with an active weekly target. As a
scheduler, shorten a visit enough to fall below target and verify the
appointment remains unchanged while a request appears in `/reductions`. As the
assigned clinical supervisor, reject one request and approve another. Confirm
the rejected appointment is unchanged, the approved proposal is applied, and
both reasons appear in the append-only audit log. Change an appointment after
request creation and verify the later approval marks the request stale instead
of applying it.

## User access-management drill

In staging, create a pending test account. As an Administrator, activate it
with each relevant role and verify that Provider activation requires an active
clinician link. Change the account to inactive and confirm its existing browser
session is rejected on the next authenticated request. Verify each decision
records the actor, old and new role/status, version, and reason in `audit_log`.
Retry one submitted command and confirm it adds no duplicate audit event. Try a
stale page version, a direct REST update, a self-demotion, and removal of the
last active Administrator; all must fail without changing the profile.

## Provider time-off drill

In staging, sign in as a linked Provider and submit a future request that
overlaps at least one scheduled visit. Confirm that the live schedule remains
unchanged while the request is pending. As a Scheduler, reject one request and
confirm that no disruption is created. Approve another and confirm in one
transaction that the request is linked to a provider callout, overlapping
visits are cancelled, recovery cases are opened, reminders are reconciled, and
both actors and reasons appear in the audit log. Also verify that a Provider
cannot read another provider's requests or approve their own request, and that
direct writes to recurring provider availability are denied.

## Backup and restore drill

At least quarterly, restore the latest backup into an approved, isolated
non-production project. Follow [the disaster-recovery procedure](DISASTER_RECOVERY.md)
to capture and compare keyed manifests across all application tables and Auth
users. Then complete the documented read-only workflow sample and record the
recovery time and recovery point. Never restore production PHI into an
unapproved developer environment.

## Monitoring

Alert on `/api/health` failures, CP-SAT solver degradation/timeouts, HTTP 5xx rate, failed login spikes, repeated
approval revalidation/rollback failures, optimizer safety-limit frequency,
push-delivery failures, database capacity, expiring credentials, and expiring
authorizations. Server logs are structured JSON and must be sent to a
HIPAA-eligible log destination with PHI scrubbing and a defined retention
period.

The `Monitor production` GitHub Actions workflow runs every 30 minutes and
retries the health, schema, security-header, and anonymous-access checks three
times. It then calls the cron-authenticated `/api/operations/alerts` endpoint.
That endpoint evaluates aggregate counts only, writes one deduplicated daily
work-queue task to the responsible role, and returns `503` for critical
conditions so the workflow alerts the on-call channel. It never returns record
identifiers, names, destinations, request URLs, or free text.

The separate `Deliver push notifications` workflow runs every five minutes.
It calls only the cron-authenticated push endpoint; delivery logs and responses
contain bounded counts and error codes, never endpoints, notification text, or
record identifiers.

Set the repository variable `PRODUCTION_URL`, configure `CRON_SECRET` and the
optional `VERCEL_AUTOMATION_BYPASS_SECRET`, and route failed-workflow
notifications to the approved on-call channel. Optional thresholds are listed
in `.env.example`; invalid values fail environment validation. The default
checks cover failed-sign-in spikes, expired and expiring authorizations and
credentials, failed or delayed communication work, frequent bounded optimizer
decisions, and push-delivery failures. Aggregate operational events are kept
for 90 days and purged by the monitor.

The workflow is not a replacement for infrastructure telemetry. The client's
hosting, Supabase, and approved log providers must still supply HTTP 5xx rate,
database capacity, incident routing, retention, and escalation controls.
Structured application logs intentionally deny arbitrary detail fields and
must be shipped only to an approved destination.

## Mobile push privacy

Push messages contain a generic task description and link only to the
authenticated `/notifications` page. Notification titles, bodies, patient
names, diagnoses, authorization numbers, appointment details, and destination
endpoints are never included in application logs or lock-screen payloads.

## Mobile installation and verified links

The installable PWA caches only its public offline screen and artwork. Confirm
that opening an authenticated patient page while offline shows the reconnect
screen and does not show a previously viewed record. Test install and push on
the supported iOS and Android versions before launch.

If the client chooses store distribution, follow
[the mobile release procedure](MOBILE_RELEASE.md). Run
`npm.cmd run verify:mobile-release`, deploy the final association configuration,
fetch both enabled `/.well-known` documents from the public production origin,
and validate links on physical devices. Store binaries, signing keys, Team ID,
package/bundle identifiers, and store submissions must use client-owned
accounts; do not build or publish with placeholder identities.
