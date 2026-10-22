# Production runbook

## Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (a monitored `mailto:` address)
- `SCHEDULING_TIMEZONE` (an IANA zone, for example `America/New_York`)
- `RELEASE_SHA` when the hosting platform does not supply `VERCEL_GIT_COMMIT_SHA`

The live communications worker additionally requires `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`, `COMMUNICATIONS_PUBLIC_BASE_URL`,
`COMMUNICATIONS_DELIVERY_ENABLED`, and a complete Twilio and/or SendGrid
configuration from `.env.example`. Webhook handlers require the corresponding
provider verification secret even when the worker is temporarily disabled.

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

The repository includes `Quality and security` and manually approved `Deploy production` GitHub Actions workflows. Configure `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, and `SUPABASE_DB_PASSWORD` as production environment secrets. The deployment workflow applies pending migrations before publishing the matching application build. Configure runtime application secrets in the Vercel project rather than passing private values through the workflow.

After deployment, run `DEPLOYMENT_URL=https://example.org npm run verify:deployment`. It verifies database health, the login route, and required security headers.

The deployment platform should poll `GET /api/health`. A `503` means the application cannot reach Supabase Auth or the database does not expose the required schema version, including atomic configuration, guarded access management, move-enabled optimization, clinical reduction review, and provider time-off commands, so that release should not receive traffic.

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

At least quarterly, restore the latest backup into an isolated non-production project. Verify row counts, authentication/profile links, care-team assignments, appointments, and the append-only audit log. Record the recovery time and recovery point. Never restore production PHI into an unapproved developer environment.

## Monitoring

Alert on `/api/health` failures, HTTP 5xx rate, failed login spikes, repeated
approval revalidation/rollback failures, optimizer safety-limit frequency,
push-delivery failures, database capacity, expiring credentials, and expiring
authorizations. Server logs are structured JSON and must be sent to a
HIPAA-eligible log destination with PHI scrubbing and a defined retention
period.

## Mobile push privacy

Push messages must contain a generic task description and link into the authenticated app. Do not include patient names, diagnoses, authorization numbers, or appointment details on a device lock screen.
