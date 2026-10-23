# Guardian portal

The guardian portal is a separate, read-only authentication boundary at
`/portal`. It does not add guardians to the seven staff roles and cannot use
staff scheduling actions.

## Access lifecycle

1. A scheduler records an active contact with legal-guardian authority, an
   approved email, and authorization to receive patient information.
2. In the patient contact card, the scheduler approves portal access with a
   reason and confirmation. The database stores a versioned, audited pending
   grant.
3. The guardian requests a Supabase one-time email link. The response is always
   generic so it does not reveal whether an email is registered.
4. After verified email sign-in, the database atomically claims every pending
   grant matching that address. The portal shows only scheduled/confirmed
   appointments in the next 90 days.
5. A scheduler can revoke access immediately. Changing the contact email,
   disabling the contact, removing legal-guardian status, or removing
   information-release authority automatically revokes it in the database.

The snapshot is returned by a security-definer function with a fixed minimal
shape. Guardians do not receive direct table access, authorization numbers,
clinical notes, communications, audit history, or staff-only controls.

## Activation

Keep `GUARDIAN_PORTAL_ENABLED=false` until the client approves the guardian
identity-verification policy, Supabase email template, redirect allowlist,
email rate limits, support/escalation owner, terms/privacy text, and staging
test guardians. Then set it to `true` in the server environment.
