# Users, roles and permissions — proposal v1

**Status: our proposal, for Baker Street to confirm or correct.**

The handoff specification requires "role-based access control" (§64) and
"human approval" of every schedule change (§60), but never says who those
humans are. It records that users exist — `optimization_requests.requested_by`,
`audit_log.user_id`, a concurrency test for "two users attempting the same
appointment" (§68) — without defining a single role.

So this document proposes the model. Nothing here is quoted from the spec;
everything is derived from the operations the system actually performs, then
assigned to the person who would realistically perform each one in a
multi-service clinic. **Open questions for the client are collected at the
end** — those are the answers we need before building the login system.

---

## How this was derived

Working from the operations the spec defines, rather than from an assumed org
chart. The system does nineteen distinct things:

| # | Operation | Spec |
|---|---|---|
| 1 | View a patient's schedule | §46 |
| 2 | View a provider's schedule | §53 |
| 3 | Check whether a booking is legal | §48 |
| 4 | Search ranked availability | §49 |
| 5 | Book, move or cancel one appointment | §21 |
| 6 | Run an optimization / fill a service | §46, §47 |
| 7 | **Approve** an optimization result | §60, §61 |
| 8 | **Reject** an optimization result | §62 |
| 9 | Override a constraint, with a reason | §26 |
| 10 | Set clinical requirements (min / target / max) | §9 |
| 11 | Enter and maintain authorizations | §10 |
| 12 | Maintain provider credentials | §12 |
| 13 | Maintain provider availability and PTO | §14 |
| 14 | Configure services and optimization profiles | §4, §42 |
| 15 | Manage rooms, equipment, locations | §18-20 |
| 16 | View department / organisation capacity | §51, §54 |
| 17 | Run what-if and hiring simulations | §50, §52 |
| 18 | Read the audit log | §26 |
| 19 | Manage users and their roles | §64 |

Each of those needs an owner. Grouping them by who would realistically do them
produces seven staff roles.

---

## The seven roles

### 1. Scheduler / Care Coordinator — `SCHEDULER`

The primary daily user; the person the product is really for. Books and moves
appointments, runs Fill Service, works the waitlist, handles the daily churn of
cancellations and callouts.

Approves routine optimization results themselves. Cannot change what a patient
clinically needs, and cannot enter authorizations.

*Estimated headcount: 3–6. Heaviest usage by far — in the system all day.*

### 2. Clinical Supervisor / BCBA — `CLINICAL`

Owns the clinical side: how many hours a patient needs, what the target is,
which services are mandatory. Approves any change that reduces a patient's
hours or drops a required service.

This role exists to keep clinical judgement separate from billing pressure —
see the separation rules below.

*Estimated headcount: 8–15 (roughly the BCBA count). Moderate usage — reviews
and approvals, not daily booking.*

### 3. Provider / Therapist — `PROVIDER`

RBTs, OTs, SLPs, therapists. Sees **their own** schedule and their own
patients. Requests time off. Cannot book themselves onto patients, cannot see
colleagues' caseloads.

This is the largest group and the lightest usage — mostly read-only, likely
mobile.

*Estimated headcount: 50–70. Low usage per person, high total.*

### 4. Authorization / Intake Specialist — `AUTHORIZATION`

Owns payer data: authorization numbers, authorized hours, effective dates,
renewals. Flags authorizations about to expire.

Explicitly **cannot** set clinical requirements. That separation is the whole
point of the role (below).

*Estimated headcount: 2–4. Moderate, bursty usage around renewal cycles.*

### 5. Operations / Practice Manager — `OPERATIONS`

Capacity across departments, utilization, unfilled demand, hiring simulations.
Reads everything, changes little. This is the role §51 and §52 were written for.

*Estimated headcount: 1–3. Low frequency, high value.*

### 6. System Administrator — `ADMIN`

Service configuration, optimization profiles, rooms and locations, user
accounts and role assignment. Should **not** routinely hold clinical or
scheduling permissions — an admin who can silently re-weight the optimization
profile can change every schedule in the building.

*Estimated headcount: 1–2.*

### 7. Compliance / Privacy Officer — `COMPLIANCE`

Read-only access to the audit log and override reasons. No ability to change a
schedule. HIPAA oversight needs someone who can see what happened without being
able to alter it.

*Estimated headcount: 1, likely part-time or an existing staff member.*

### Not proposed, worth asking about: parent / guardian portal

The spec never mentions patients or families logging in. A parent portal
(view my child's schedule, request a change) is a common next ask and would
change the security model substantially — it is the difference between an
internal tool and a public-facing one. **Out of scope unless the client says
otherwise.**

---

## Permission matrix

`✓` full · `~` limited, see note · `—` none

| Operation | SCHEDULER | CLINICAL | PROVIDER | AUTHORIZATION | OPERATIONS | ADMIN | COMPLIANCE |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| View patient schedule | ✓ | ✓ | ~1 | ~2 | ✓ | — | — |
| View provider schedule | ✓ | ✓ | ~1 | — | ✓ | — | — |
| Check conflict | ✓ | ✓ | ✓ | — | ✓ | — | — |
| Search availability | ✓ | ✓ | ~1 | — | ✓ | — | — |
| Book / move / cancel | ✓ | ✓ | — | — | — | — | — |
| Run optimization | ✓ | ✓ | — | — | ~3 | — | — |
| **Approve result** | ~4 | ✓ | — | — | — | — | — |
| **Reject result** | ✓ | ✓ | — | — | — | — | — |
| Override a constraint | ~5 | ✓ | — | — | — | — | — |
| Set clinical requirements | — | ✓ | — | — | — | — | — |
| Enter authorizations | — | — | — | ✓ | — | — | — |
| Maintain credentials | — | ✓ | — | — | — | ✓ | — |
| Provider availability / PTO | ✓ | — | ~6 | — | — | — | — |
| Configure services / profiles | — | — | — | — | — | ✓ | — |
| Manage rooms & locations | — | — | — | — | ~7 | ✓ | — |
| Capacity analytics | ~8 | ~8 | — | — | ✓ | — | — |
| What-if / hiring simulation | — | — | — | — | ✓ | — | — |
| Read audit log | — | ~9 | — | — | ~9 | ✓ | ✓ |
| Manage users and roles | — | — | — | — | — | ✓ | — |

1. **Own caseload only.** A therapist sees their own week and their own
   patients. Minimum-necessary access (§64) means they should not browse
   colleagues' caseloads.
2. **Authorization-relevant fields only** — hours used against an
   authorization, not the full clinical record.
3. Read-only / simulation mode. Operations can model changes, not commit them.
4. **Routine changes only.** See the approval threshold rule below.
5. Overrides that do not touch authorization or credentials. Never those two —
   §59 forbids even the AI from overriding them, and the same logic applies to
   a scheduler.
6. **Request**, not set. A provider requests time off; a scheduler or manager
   approves it. Otherwise availability becomes unreliable and every downstream
   optimization inherits the error.
7. Day-to-day room availability (out of service, maintenance), not creating or
   deleting rooms.
8. Their own patients / their own department, not organisation-wide.
9. Scoped to their own patients or department, not the full log.

---

## Three separation-of-duties rules that matter

These are the reason for the role split. Without them you could collapse this
into "staff" and "admin" and be done.

### 1. Whoever enters the authorization must not set clinical need

The spec's central modelling insistence is that authorized hours and clinical
need are different things (§9, §10). Making them different *people* enforces
that organisationally, not just in the schema.

If one person controls both numbers, there is quiet pressure to make clinical
need equal whatever the payer approved — 30 authorized becomes 30 "needed", and
the distinction the entire data model is built around evaporates in practice.
Billing enters *30 authorized*; the BCBA independently sets *floor 20, target
25, maximum 30*.

### 2. Reducing care needs clinical sign-off

A scheduler can approve a change that adds hours, moves an appointment or swaps
a provider. A change that **reduces a patient's hours below their clinical
target, or drops a required service**, needs `CLINICAL` approval.

This is the approval threshold behind note 4. It is a clinical safety line, and
it is cheap to implement now and painful to retrofit.

### 3. Every override carries a reason, and the reason is permanent

`audit_log.override_reason` already exists in the schema. No override should be
possible without it, and the audit log must be append-only — nobody, including
`ADMIN`, should be able to edit or delete history. `COMPLIANCE` can read it and
change nothing.

---

## Sizing

| | Named accounts | Typical concurrent |
|---|---|---|
| Providers | 50–70 | 5–15 (mostly mobile, read-only) |
| Schedulers | 3–6 | 3–6 (in it all day) |
| Clinical supervisors | 8–15 | 2–5 |
| Authorization specialists | 2–4 | 1–3 |
| Operations | 1–3 | 0–1 |
| Admin | 1–2 | 0–1 |
| Compliance | 1 | 0–1 |
| **Total** | **~70–100** | **~10–25** |

Derived from §51's worked example (1,420 authorized ABA hours per week, 146
hours of spare RBT capacity), which implies roughly 50 ABA patients and 40–50
RBTs. **This needs confirming — it may be an illustrative figure rather than
Baker Street's real numbers.**

### What the sizing means technically

This is a **low-concurrency, high-complexity** system. Ten to twenty-five
simultaneous users is small; the difficulty is in the optimization, not the
load. So:

- No need to design for horizontal scale or heavy caching.
- The §65 performance targets (500ms conflict check, 5s patient optimization)
  are about *one user waiting*, not throughput.
- The concurrency risk is **collision, not volume** — two schedulers working
  the same patient at once, which §63's transactional approval already guards
  against. That matters far more here than requests per second.

---

## Open questions for the client

Grouped by how much they change the build.

**Blocking — cannot build the login system without these:**

1. Do these seven roles match how Baker Street actually works, or are some of
   them the same person? (Small clinics often merge scheduler + authorization.)
2. Who is allowed to approve a schedule change that **reduces** a patient's
   hours? We propose clinical supervisors only.
3. Should a therapist see only their own schedule, or their whole team's?

**Shapes the architecture:**

4. Is there an existing EHR this must sit next to, or inside? §75 shows
   "WEB / EHR UI", which implies integration — that could mean single sign-on
   and would change the whole authentication approach.
5. Do parents or guardians ever log in? Out of scope as proposed.
6. Real patient and staff numbers, to confirm or replace the estimate above.

**Needed before real patient data, not before building:**

7. Who is the named privacy/compliance officer?
8. Is there an existing identity provider (Microsoft 365, Google Workspace,
   Okta) staff already sign into? If so we should use it rather than build our
   own passwords — fewer credentials, better security, faster to build.
9. Do any staff work across multiple locations with different access?

---

## What this means for implementation

Nothing is built yet — **the application currently has no authentication at
all.** That is acceptable while it runs on synthetic data and unacceptable the
moment real patient information appears.

When we do build it, in order:

1. **Authentication** — ideally the client's existing identity provider
   (question 8), not passwords we manage.
2. **Role assignment**, one role per user to start. Multi-role users are a
   complication to add only if the client says the same person genuinely wears
   two hats.
3. **Row-level security in Postgres**, not just checks in the application.
   A therapist restricted to their own caseload should be restricted *at the
   database*, so a bug in a query cannot leak another patient's record.
4. **The approval threshold** (rule 2) — a check in the approval transaction
   that already exists in §63's flow.
5. **Append-only audit log**, with overrides required to carry a reason.

Steps 1–3 are the gate for real PHI. They sit alongside the Supabase paid plan
and the signed business associate agreement, not after them.

---

## Implementation status

The role model above is now live in the application.

- `lib/auth/roles.ts` — the permission list, the seven role definitions and the
  navigation map. **Single source of truth.** A screen that checks a role name
  directly (`if role === "ADMIN"`) will drift the moment the client corrects
  the model; screens ask `can(role, permission)` instead.
- `lib/auth/session.ts` — **demo sessions only. This is not authentication.**
  A role name in a cookie, no password, nothing verified.
- `app/(app)/layout.tsx` — navigation built from the signed-in role's
  permissions.
- `app/no-access/page.tsx` — where a failed permission check lands: it names
  the role held, says what that role is for, and lists where the user can go.

Verified access matrix (`OK` = page renders, `blocked` = redirected):

| Role | schedule | optimize | authorizations | clinical | capacity | configuration | audit |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Scheduler | OK | OK | blocked | blocked | OK | blocked | blocked |
| Clinical supervisor | OK | OK | blocked | OK | OK | blocked | OK |
| Therapist | OK | blocked | blocked | blocked | blocked | blocked | blocked |
| Authorization | OK | blocked | OK | blocked | blocked | blocked | blocked |
| Operations | OK | blocked | blocked | blocked | OK | blocked | OK |
| Administrator | blocked | blocked | blocked | blocked | blocked | OK | OK |
| Compliance | blocked | blocked | blocked | blocked | blocked | blocked | OK |

Administrators having no schedule access is deliberate, not an oversight — see
separation rule 1.

**Data scoping is enforced, not just hidden.** Signed in as a therapist, the
schedule index lists only that clinician and only the patients they actually
see. That is currently a filter in the query; it must also become Postgres
row-level security before real patient data, so a bug in one query cannot leak
another patient's record.

### Still to build

1. Real authentication, replacing the cookie switcher entirely.
2. Roles read from the database rather than chosen from a menu.
3. Row-level security in Postgres.
4. The approval threshold (separation rule 2) inside the commit transaction.
5. Write access — every screen is currently read-only, so no audit entries
   exist yet.
