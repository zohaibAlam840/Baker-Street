# Production runbook

## Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (a monitored `mailto:` address)
- `RELEASE_SHA` when the hosting platform does not supply `VERCEL_GIT_COMMIT_SHA`

Never expose the service-role key to the browser. It is only needed for controlled seed and administrative jobs.

## Release gate

Run these commands before every deployment:

```powershell
npm.cmd ci
npm.cmd audit --omit=dev --audit-level=high
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npx.cmd supabase test db --linked supabase/tests/rls_access.sql
npm.cmd run build
```

The repository includes `Quality and security` and manually approved `Deploy production` GitHub Actions workflows. Configure `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` as production environment secrets. Configure application secrets in the Vercel project rather than passing private values through the workflow.

After deployment, run `DEPLOYMENT_URL=https://example.org npm run verify:deployment`. It verifies database health, the login route, and required security headers.

The deployment platform should poll `GET /api/health`. A `503` means the application cannot reach Supabase Auth and should not receive traffic.

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

Alert on `/api/health` failures, HTTP 5xx rate, failed login spikes, push-delivery failures, database capacity, expiring credentials, and expiring authorizations. Server logs are structured JSON and must be sent to a HIPAA-eligible log destination with PHI scrubbing and a defined retention period.

## Mobile push privacy

Push messages must contain a generic task description and link into the authenticated app. Do not include patient names, diagnoses, authorization numbers, or appointment details on a device lock screen.
