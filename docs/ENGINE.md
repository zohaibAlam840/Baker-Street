# Scheduling engine and approval workflow

The application implements the scheduling foundation, deterministic
multi-service plan generation, and human approval workflow described in
*Dynamic Scheduler for BSH-1.docx* v2.0. AI does not decide a schedule. An
optional private CP-SAT service can prove the generated additions model while
the same human approval and database safeguards remain authoritative.

## The rule that shapes everything

ABA is a row in `services` with an `optimization_profile`. It is not a branch
in any code path. Adding Podiatry should mean inserting configuration rows,
not editing the engine. Code such as `if (service_code === "ABA_DIRECT")`
would break the service-agnostic model.

Authorization and clinical need also remain separate. Payer authorization is
a ceiling; `patient_service_requirements` independently stores the clinical
minimum, target, maximum, required flag, and priority.

## Layout

```text
supabase/migrations/                    Schema, Auth profiles, RLS, workflows,
                                        push, and atomic optimizer approval
supabase/tests/rls_access.sql           Seven-role database access checks
scripts/seed.ts                         Deterministic synthetic clinic seed
scripts/seed-auth-users.ts              Test accounts for all roles

lib/domain/time.ts                      Zoned wall-clock helpers
lib/domain/slots.ts                     15-minute grid and range algebra
lib/domain/types.ts                     Domain and candidate types

lib/rules/context.ts                    In-memory horizon snapshot
lib/rules/violations.ts                 Structured rejection reasons
lib/rules/engine.ts                     Shared scheduling constraints
lib/rules/travel.ts                     Pluggable travel model

lib/scheduling/availability.ts          Ranked single-visit slot search
lib/scheduling/candidates.ts            Legal candidate generation
lib/scheduling/fillService.ts           Focused single-service bounds
lib/scheduling/optimizer.ts             Bounded multi-service week search
lib/scheduling/actions.ts               Server-side approval orchestration
lib/scheduling/weekView.ts              Calendar projection
lib/scheduling/summary.ts               Scheduled / need / authorization view

app/api/scheduling/check-conflict/      Conflict-check API
app/api/scheduling/availability/        Ranked-availability API
app/api/scheduling/fill-service/        Single-service analysis API
app/(app)/approvals/                     Plan comparison and approval
components/optimizer/                   Mobile-ready approval controls
```

## Two planning tools, with different promises

### Focused Fill Service analysis

`analyseFillService()` answers how close one patient can get to a target for
one service. It brackets the answer instead of pretending its greedy packing
is always optimal:

| Field | Meaning |
|---|---|
| `upper_bound_additional_hours` | The most that could fit under perfect packing, capped by authorization and the clinical maximum. |
| `achievable_additional_hours` | Hours the legal longest-first pass actually places. |
| `exact` | The bounds agree, so no arrangement can add more hours for that focused question. |

This remains useful for a quick capacity explanation and the Fill Service API.
It does not coordinate competing services and it never commits its analytical
placements.

### Multi-service patient-week optimizer

`optimizePatientWeek()` considers every configured service goal for the patient
together. It:

1. Builds clinical goals from requirements, active authorizations, and current
   scheduled care.
2. Generates candidates across eligible providers, declared clinical
   locations, legal durations, authorizations, and alternative rooms/resources.
3. Rejects candidates that fail the shared rule engine, including DST-invalid
   wall-clock ranges.
4. Sends the PHI-minimized integer model to authenticated Google OR-Tools
   CP-SAT when configured; otherwise searches the deterministic bounded beam.
   Both use balanced coverage, continuity, fewest visits, preferences, and
   earliest completion objective orders.
5. Re-proves every selected appointment together against a progressively
   updated snapshot before returning a plan.
6. Produces stable plan IDs from canonical clinical goals, selected
   appointments, and metrics so the reviewed option can be identified safely.

The result status is intentionally explicit:

| Status | Meaning |
|---|---|
| `TARGETS_MET` | A legal plan reaches every configured target. |
| `FEASIBLE` | A legal improvement was found but some targets remain short. |
| `INFEASIBLE` | No addable legal plan was found for the current snapshot. |
| `BOUNDED` | A safety limit was reached; this is the best plan found, not proof that no better plan exists. |

The CP-SAT service receives opaque IDs and integer constraints, never patient
names, contacts, diagnoses, free text, database credentials, locations, or
resources. Every returned selection is re-proved by the TypeScript rules. If
the service is disabled or unavailable, the bounded local engine remains the
safe default. See [CP-SAT service](CP_SAT_SOLVER.md).

Generated options have an explicit human decision queue. A permitted scheduler
or clinical supervisor may reject an option with a reason or defer it until a
time later in the same scheduling week. The server recomputes the stable plan
before recording the decision; active decisions are serialized in Postgres,
cannot be overwritten by a concurrent reviewer, and are copied to the audit
stream. Due deferrals return automatically to the active options view.

## Atomic human approval

The optimizer proposes and a permitted person approves. The browser sends only
the patient, week, stable plan ID, and approval reason; it never supplies the
appointment payload that will be written.

`approveOptimizationPlan()` performs the following sequence:

1. Requires `schedule.approve` and a meaningful reason.
2. Checks the idempotency key first, making a retry after a lost mobile response
   safe.
3. Reloads fresh RLS-scoped data in the patient's timezone.
4. Recomputes the plans and rejects an option whose stable ID disappeared.
5. Sends only the server-reconstructed plan to
   `approve_optimization_plan(...)`.

The Postgres function is the commit boundary. It locks and revalidates the
live patient, provider, authorization, availability, and resource state,
enforces the weekly clinical limits, and inserts the optimization request,
appointments, resource links, and audit entry in one transaction. Any error
rolls back every write. The unique idempotency key prevents duplicate approval.

Successful approval revalidates the dashboard, schedule, approvals page, and
patient record. The audit log records the actor, request/result linkage, plan
summary, and decision reason.

## Why the rule engine is shared

`evaluateBooking()` serves conflict checks, ranked availability, candidate
generation, optimizer proof, and interactive booking validation. Rules return
structured reasons rather than booleans, every rule runs, and no rule queries
the database. This keeps explanations useful and prevents separate callers
from silently developing different definitions of “legal.”

The database repeats authoritative commit-time checks. That is deliberate,
not duplicate business logic by accident: in-memory evaluation creates fast,
explainable options, while the transaction protects against stale data and
concurrent users.

For caseload-scoped clinical users, `optimization_busy_intervals` supplies
PHI-minimal occupied intervals for unrelated patients. The optimizer can avoid
provider and room collisions without exposing whose appointment created the
busy time.

## Time and horizons

All scheduling arithmetic uses a 15-minute `SlotGrid`. Local availability is
expanded in the configured IANA timezone; appointment timestamps remain
absolute instants. Wall-clock ranges that are nonexistent or ambiguous at a
DST transition are rejected.

Weekly totals require a whole-week horizon. Routes normalize an input date to
the containing Monday, and availability searches load complete weeks before
narrowing the returned window.

The in-memory authorization usage helper sees appointments loaded in the
current horizon. For an authorization spanning a longer period, the database
approval function performs the authoritative full-period check and may reject
a plan if usage changed or existed outside the displayed week.

## Interface behavior

The responsive shell uses a desktop sidebar and a phone bottom bar. Navigation
comes from the signed-in profile's permissions. Provider and clinical access is
also constrained by Postgres RLS, provider/profile links, and care-team rows;
hiding a navigation item is not the security boundary.

The calendar views remain useful read surfaces, while authorized workflows can
create and update appointments, configuration, clinical/payer records, and
care-team assignments. The Plan optimizer compares complete alternatives and
uses an explicit review/confirmation step before approval.

When an additions-only plan leaves more required or target care uncovered, the
optimizer may explore a bounded one-move rescue. It removes one future
in-person `FLEXIBLE` visit from an in-memory clone, generates legal same-duration
destinations, restores the visit in each clone, and reruns the multi-service
search. A move is retained only when its clinical coverage is strictly better
than the additions-only baseline. Approval recomputes that exact plan and the
database compares the source visit's time, clinician, location, authorization,
status, flexibility, and resources before committing the move and all additions
in one transaction. Stale plans roll back without partial changes.

Color never carries meaning alone. Calendar blocks retain labels and accessible
state text, and wide views have table or horizontally scrollable equivalents
for mobile use.

## Acceptance scenario

`lib/testing/scenario.ts` builds John Reyes with 30 authorized ABA hours, 27
scheduled hours, required therapy/OT/parent-training care, multiple clinicians,
two clinics, a school block, rooms, and locked/protected appointments.

The focused Fill Service bounds agree that exactly three ABA hours can be added
in the acceptance week. The multi-service optimizer independently protects all
required services while comparing the legal ways to close that gap. This
scenario is a regression fixture, not production data.

## Running locally

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run dev
```

For live data, configure `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, then apply every migration in
`supabase/migrations` in order. Do not install only `supabase/schema.sql`; it
does not represent the complete migrated application.

Ordinary application reads use the authenticated user's Supabase session and
RLS. `SUPABASE_SERVICE_ROLE_KEY` is server-only and reserved for controlled
seed/administrative scripts.

```powershell
npx.cmd supabase db push --linked
npx.cmd tsx scripts/seed.ts
npm.cmd run seed:users
```

Use `USE_SYNTHETIC_DATA=true` only when intentionally running the built-in
clinic fixture.

## Performance and determinism

Candidate generation caches week dates and wall-clock conversions. Candidate
counts scale with open time; `startStepSlots` trades granularity for speed and
`maxCandidates` is the generation safety valve. The optimizer separately caps
search candidates, beam width, and search operations.

Database row order must not affect candidate order, plan selection, or plan
IDs. Providers, services, durations, authorizations, locations, resources, and
tie-breakers are canonicalized. Regression tests reverse snapshot rows and
assert identical plan identities.

## Current boundaries

- CP-SAT proves optimality only over a complete generated additions candidate
  set. Candidate truncation/reduction, time limits, fallback, and move rescue
  remain honestly bounded.
- It adds appointments and, only when additions alone leave more care
  uncovered, can compare a bounded set of plans that move one in-person
  `FLEXIBLE` scheduled/confirmed visit. A move preserves service, duration,
  authorization, status, and weekly clinical hours.
- It does not cancel visits, reduce care, chain multiple moves, or rearrange
  `PROTECTED`/`LOCKED` appointments.
- Fill Service remains a focused greedy lower-bound/upper-bound analysis.
- The mobile PWA, safe offline boundary, install flow, and Android/iOS verified
  link endpoints are included. Store-signed binaries still require the client's
  final domain, developer accounts, package identities, and signing material.
  FHIR R4 EHR and Claim drafts plus authenticated adapters are present; vendor
  writes and live claims remain disabled pending approved mappings. Optional
  model interpretation is gated by PHI approval and can never replace
  rule-engine results.
- Synthetic data is available for demonstrations, but production readiness
  still requires the controls and drills in `docs/PRODUCTION_RUNBOOK.md`.
