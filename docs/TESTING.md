# End-to-end testing

The Playwright suite covers the public entry points on desktop and mobile, the
health contract, real Supabase sign-in, navigation filtering, direct-route
authorization, and the highest-risk role workflows. The linked tests are
read-only: they do not approve plans, alter appointments, or change access.

## Local commands

Install the Chromium test browser once:

```powershell
npx.cmd playwright install chromium
```

If the pinned browser download is unavailable but Google Chrome is already
installed, set `E2E_BROWSER_CHANNEL=chrome` for the local run.

Run the full suite:

```powershell
npm.cmd run test:e2e
```

Playwright starts the development server on port `3100`. Set `E2E_PORT` to use
another local port, or set `E2E_BASE_URL` to test an already-running deployment.
After `npm run build`, set `E2E_PRODUCTION_SERVER=true` to exercise the local
production server; CI uses this mode automatically.

Public tests need the same Supabase URL and publishable key used by the app.
Linked role tests also require `TEST_USER_PASSWORD` and the deterministic
accounts created by:

```powershell
npm.cmd run seed:users
```

If the password is absent, role tests are reported as skipped while the public
and health tests still run. Useful targeted commands are:

```powershell
npm.cmd run test:e2e:public
npm.cmd run test:e2e:roles
npm.cmd run test:e2e:report
```

The production monitor additionally calls the operational alert endpoint. To
exercise it against an approved non-production deployment without printing the
secret, set `DEPLOYMENT_URL` and `CRON_SECRET` in the shell, then run:

```powershell
Invoke-RestMethod -Uri "$env:DEPLOYMENT_URL/api/operations/alerts" `
  -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }

Invoke-RestMethod -Uri "$env:DEPLOYMENT_URL/api/push/deliver" `
  -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

An `ok` or `warning` result returns HTTP 200. A critical threshold or an
unavailable database returns HTTP 503. The response contains aggregate issue
codes and counts only.
The push response likewise contains bounded delivery counts only. Run it only
against an approved environment because it sends real generic alerts to active
staff subscriptions.

Do not point mutation tests at production. Atomic approval, clinical reduction,
time-off, and access-management mutations remain covered by pgTAP and the
staging drills in `docs/PRODUCTION_RUNBOOK.md` until isolated browser fixtures
and cleanup transactions are available.
