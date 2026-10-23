# User access management

The Administrator screen at `/configuration/users` controls application access
without granting administrators direct write permission on `user_profiles`.
All mutations pass through the `manage_user_access` database command.

## Workflow

1. A new Supabase Auth account creates an inactive profile with its requested
   role. Authentication alone does not provide application access.
2. An active Administrator selects the approved role, access status, and any
   clinician link, records a reason, and confirms the decision.
3. The database locks the current profile version, validates the role/link,
   changes the profile, appends an audit event, and records the command result
   for safe retry in one transaction.
4. Activation creates a generic in-app notification. Deactivation is enforced
   on the account's next authenticated request because every protected route
   resolves an active profile rather than trusting the Auth session alone.

## Safety rules

- Only an active `ADMIN` may invoke the command.
- Active Provider accounts require an active clinician link. Clinical accounts
  may be linked when the person also needs provider-scoped behavior. Other
  roles cannot carry a clinician link.
- An Administrator cannot change their own role or access status. Another
  active Administrator must make that decision.
- The last active Administrator cannot be deactivated or moved to another role.
  A global transaction lock prevents concurrent demotions from racing around
  this rule.
- Expected profile versions reject stale forms. Actor-scoped idempotency keys
  make a retried mobile submission return the original result.
- Authenticated clients have no direct insert, update, or delete privilege on
  profiles or on the private access-command ledger.
- Audit payloads contain account IDs, roles, clinician IDs, statuses, versions,
  and the administrator's reason; they do not copy email addresses or passwords.

## Client decisions still required

The client should confirm who may approve Administrator and Compliance roles,
whether two-person approval is required for privileged roles, the offboarding
service-level target, and whether production authentication will remain
Supabase email/password or use the practice's identity provider.

## Release verification

Apply `supabase/migrations/20261022040000_user_access_management.sql`. The
health endpoint then requires schema version `20261024010000` and the
`access_management` capability. Run the pgTAP suite and the staging drill in
`docs/PRODUCTION_RUNBOOK.md` before production use.
