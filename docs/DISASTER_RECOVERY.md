# Backup and restore verification

Use this drill at least quarterly and after a material schema or hosting change.
It verifies every application table and Supabase Auth user using keyed HMACs of
canonical row data. The tool does not print row contents, identifiers, row
counts, or HMACs to the console. It is read-only against both projects.

The manifest itself contains table counts and keyed digests. Treat it as
sensitive operational data, keep it outside source control, and retain it only
under the organization's approved security policy.

## Before the drill

1. Confirm the production Supabase plan, point-in-time recovery retention, and
   latest successful backup with the client owner.
2. Obtain approval for an isolated restore project covered by the same required
   agreements and controls. Never restore production PHI to a developer laptop
   or an unapproved project.
3. Generate a unique random HMAC key of at least 32 characters. Keep the same
   key for capture and verification, then dispose of it under the secret policy.
4. Use service-role credentials only in the secure operator shell. Do not save
   them in the repository, workflow logs, screenshots, or tickets.

## Capture the source manifest

Capture immediately before the backup or recovery point being tested. The
command refuses to overwrite an existing manifest.

```powershell
$env:RECOVERY_SUPABASE_URL = "https://source-project.supabase.co"
$env:RECOVERY_SUPABASE_SERVICE_ROLE_KEY = "..."
$env:RECOVERY_MANIFEST_HMAC_KEY = "...at-least-32-random-characters..."
npm.cmd run recovery:manifest -- capture recovery-manifest.json
```

Record the manifest timestamp and the corresponding recovery point. Database
activity after capture will correctly cause a mismatch, so coordinate a quiet
window or use a recovery point aligned to the capture.

## Restore and verify

Restore the selected backup into the approved isolated project. Then replace
only the URL and service-role key in the operator shell; keep the HMAC key.

```powershell
$env:RECOVERY_SUPABASE_URL = "https://isolated-restore.supabase.co"
$env:RECOVERY_SUPABASE_SERVICE_ROLE_KEY = "..."
npm.cmd run recovery:manifest -- verify recovery-manifest.json
```

Verification fails closed when the schema is not ready, a table cannot be read,
the target host matches the source host, authentication users differ, or any
table's row count or full-row HMAC differs. Failure output identifies only the
affected table, never row data.

After an exact match, complete a controlled sign-in and a small read-only
workflow sample. Record recovery time, recovery point, approver, results, and
follow-up actions without copying PHI into the drill record. Remove the isolated
restore and rotate temporary credentials according to the organization's
retention and destruction policy.
