# Production runbook

## Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (a monitored `mailto:` address)
- `SCHEDULING_TIMEZONE` (an IANA zone, for example `America/New_York`)
- `RELEASE_SHA` when the hosting platform does not supply `VERCEL_GIT_COMMIT_SHA`

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
```

Review the dry-run migration list before applying it. Deploy every file under
`supabase/migrations` in order; the application requires the role/RLS,
operational-workflow, busy-interval, and optimizer-approval migrations, not
only the original schema. Apply and validate migrations in a production-like
staging project before production.

The repository includes `Quality and security` and manually approved `Deploy production` GitHub Actions workflows. Configure `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, and `SUPABASE_DB_PASSWORD` as production environment secrets. The deployment workflow applies pending migrations before publishing the matching application build. Configure runtime application secrets in the Vercel project rather than passing private values through the workflow.

After deployment, run `DEPLOYMENT_URL=https://example.org npm run verify:deployment`. It verifies database health, the login route, and required security headers.

The deployment platform should poll `GET /api/health`. A `503` means the application cannot reach Supabase Auth or the database does not expose the required schema version, so that release should not receive traffic.

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
