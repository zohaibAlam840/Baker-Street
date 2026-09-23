# Scheduling engine — Phase 1

Implements Phase 1 of *Dynamic Scheduler for BSH-1.docx* v2.0 (§71): database,
service configuration, and conflict detection. No solver, no AI — both come
later, and §71 is explicit that they should.

## The rule that shapes everything

ABA is a row in `services` with an `optimization_profile`. It is not a branch in
any code path. Adding Podiatry (§72) should mean inserting configuration rows,
not editing the engine. If you find yourself writing `if (service_code ===
"ABA_DIRECT")`, that is the failure mode §74 warns about.

## Layout

```
supabase/schema.sql          22 tables, spec §9-26. Paste into the SQL editor.
scripts/seed.ts              Projects the acceptance scenario into Supabase.

lib/domain/time.ts           Timezone-aware wall-clock helpers. DST-safe.
lib/domain/slots.ts          The 15-minute slot grid (§28) and range algebra.
lib/domain/types.ts          Row types + CandidateAppointment (§27).

lib/rules/context.ts         In-memory horizon snapshot; derived availability.
lib/rules/violations.ts      Typed, structured rejection reasons.
lib/rules/engine.ts          The 17 hard/soft rules (§6).
lib/rules/travel.ts          Pluggable travel model (§40).

lib/scheduling/availability.ts   Ranked slot search (§49).
lib/scheduling/candidates.ts     Candidate generation (§29-30).
lib/scheduling/fillService.ts    Fill Service analysis (§43-44, 51, 67).
lib/scheduling/weekView.ts       Grid view model (pure projection).
lib/scheduling/summary.ts        Per-service scheduled / need / authorized.
lib/data/snapshot.ts         Supabase loader, with a synthetic fallback.
lib/testing/scenario.ts      The §70/§77 acceptance scenario.

app/api/scheduling/check-conflict/  POST, §48
app/api/scheduling/availability/    GET,  §49
app/api/scheduling/fill-service/    POST, §47

app/schedule/                       Index: patients and providers
app/schedule/patient/[patientId]/   Patient week view
app/schedule/provider/[providerId]/ Provider week view
components/schedule/                Grid, stat tiles, legend, table views
```

## Answering the acceptance question without a solver

`analyseFillService()` brackets the answer instead of pretending to optimize:

| | meaning |
|---|---|
| `upper_bound_additional_hours` | the most that could fit under perfect packing — the patient/provider overlap, capped by authorization and clinical maximum. No optimum can beat it. |
| `achievable_additional_hours` | what a greedy longest-first pass actually places. No optimum is worse. |
| `exact` | the two agree, so the answer is provably best and CP-SAT would add nothing. |

On the acceptance scenario both come to 3h, so `exact` is true: John reaches
exactly 30 ABA hours via a single Saturday 14:00–17:00 block with Cara, and the
three required services are untouched. That question is answered, today,
without a solver.

Ask for 40 hours and it reports why not, most-limiting first (§67):

```
1. Only 3h of authorization remain.
2. Clinical maximum is 30h per week.
3. 3h held by protected or locked appointments for other services.
4. Only 8h where the patient is free and an eligible provider is available.
5. Patient is unavailable during school.
```

### What this still cannot do

Each run considers **one service in isolation**. Ask it to fill ABA and it will
claim the Saturday gap; ask it to fill parent training and it will claim the
same gap. Resolving that competition — every service weighed together against a
configurable objective hierarchy (§7) — is exactly what CP-SAT is for, and it
is the reason Phase 2 exists. Greedy also cannot prove optimality when the
bounds disagree; it reports `PACKING_GAP` and says so.

## The read-only UI

Two week views, both server-rendered, both read-only. Phase 1 has no solver and
no writes, so nothing here edits anything — the point is to *see* what the rule
engine is reasoning about.

The grid defaults every column to blocked and lets availability punch lighter
holes in it, so "when could this patient be seen?" is the shape you read
directly rather than infer from absence. On the acceptance scenario the free
Saturday 14:00–17:00 gap is visible at a glance — the exact three hours the
optimizer will fight over in Phase 2.

### Colour

Blocks are tinted by **department**, not by service, using four hues validated
against all pairs in both light and dark mode (colourblind separation and
normal-vision floors). Departments past the fourth fold into "other" rather
than taking a fifth hue — no fifth colour clears the gate against these four.

Nothing depends on colour alone: every block carries its service name, locked
and protected appointments carry a glyph and a screen-reader label, and both
views have a table twin showing the same values with no colour at all. **Do not
substitute the hexes in `globals.css` without re-running a palette validator.**

### Stat tiles

"27 of 30 hours" is one number with a context, so it is a stat tile, not a
chart of a single value. The patient view's tiles deliberately keep scheduled,
target and authorized visually separate, and the authorization tile says in
words that unused authorization is *not* the same as available capacity (§51).

## Why the rule engine is shaped this way

**One implementation, three callers.** `evaluateBooking()` serves
`/check-conflict` today, and in Phase 2 it becomes both the candidate-generation
pre-filter (§29) and the revalidation step inside the approval transaction
(§63). Three copies of "is this legal?" would drift, and the copy that drifts is
the one guarding the commit.

**Rules return reasons, not booleans.** §67 requires infeasibility to be
explained — "27 available RBT hours", "no eligible RBT Wednesday 3-5",
"remaining authorization = 3 hours". That is only possible if every rejection
carries structured detail. `Violation.detail` is what the explanation layer will
quote.

**Every rule runs; none short-circuit.** A user fixing one conflict wants to see
the other three.

**Pure functions over an in-memory snapshot.** No rule queries the database.
Candidate generation will call these thousands of times per run, and the what-if
engine (§50) needs to clone a scenario without touching production data. It also
means the whole engine ports to Python unchanged if CP-SAT ends up in a separate
service.

## Authorization is not clinical need

`authorizations.authorized_hours` is a ceiling from the payer.
`patient_service_requirements` carries the clinical floor, target and maximum,
independently. A patient can be authorized 30h, clinically need 20h, and be
targeted at 25h. The engine never treats authorized hours as required hours —
§10 is emphatic about this and it is the single easiest thing to get wrong.

## Horizons must span whole weeks

Weekly figures (authorized hours per week, required sessions per week) are
computed from the appointments inside the loaded horizon. A horizon anchored on
whatever day the caller asked about silently excludes the rest of that week and
reports hours as available that are already spent. Both routes anchor to
`startOfWeek()`; `findAvailability()` takes a separate `window` so results can
still be narrowed to the requested dates. There is a regression test for this in
`lib/domain/time.test.ts`.

### Known limitation

`slotsUsedAgainstAuthorization()` counts only appointments **inside the
horizon**. That is correct for authorizations scoped to a week. An authorization
spanning months will under-count usage from outside the loaded window. Before
real data, either load usage totals separately or store a running
`units_consumed` on the authorization.

## Running it

```bash
npm run test        # 53 constraint tests
npm run typecheck
npm run dev         # then open /schedule
```

If `npm run dev` ever dies with a Turbopack panic citing
`0xc0000142` while processing `globals.css`, that is Windows failing to spawn
the PostCSS worker — usually too many stale `node` processes. Kill them, or run
`npx next dev --webpack` as a fallback. It is not a CSS error; the stylesheet
compiles cleanly under the Tailwind CLI.

Without Supabase credentials the API routes fall back to the built-in scenario
so the endpoints work on a fresh clone. Every response carries
`meta.synthetic_data`, so a demo is never mistaken for real data.

With Supabase:

```bash
# 1. Paste supabase/schema.sql into the SQL editor and run it.
# 2. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
npx tsx scripts/seed.ts
```

### Try it

```bash
curl "http://localhost:3000/api/scheduling/availability?\
patient_id=pat-john&service_id=svc-aba-direct&\
date_start=2026-09-21&date_end=2026-09-27&duration=60&limit=5"
```

## The acceptance scenario

`lib/testing/scenario.ts` builds §70/§77: John Reyes, 30h ABA authorized, 27h
scheduled, one required session each of therapy, OT and parent training, four
RBTs on different availability patterns, two clinics, a school block, and
protected and locked appointments.

The week is deliberately tight. Exactly three unbooked hours sit inside John's
availability — Saturday 14:00–17:00 — and Alice (his usual RBT, and his stated
preference) leaves at 15:00, so reaching 30 hours costs either a provider change
or a location change. That is the trade-off §8 says the system must surface as
*alternatives* rather than collapsing into one answer.

## What Phase 2 adds

Candidate generation (§29-30) and infeasibility explanation (§67) are **done** —
`generateCandidates()` already emits `CandidateAppointment[]`, the exact shape
CP-SAT consumes as optional intervals, with the rejection tally that feeds the
explanations.

What remains is the solver itself: CP-SAT over those candidates (§31-37),
lexicographic optimization (§45), and Top-N diverse solutions (§56). CP-SAT has
no JavaScript port, so that needs a Python service. Everything under `lib/rules`
and `lib/scheduling` is free of Next.js and Supabase imports precisely so it can
move there — `generateCandidates()` output serialises straight to JSON and can
be handed over a wire unchanged.

### Performance note

Rule evaluation runs tens of thousands of times per generation, so the date
rules read `ScheduleContext.dateOfSlot()` rather than formatting through `Intl`
— a week has seven answers, and caching them cut the acceptance analysis from
2.2s to 0.95s. Keep `Intl` out of the hot path.

Candidate counts scale with open time; `startStepSlots` trades granularity for
speed (4 = hourly starts, roughly 3x faster), and `maxCandidates` is the safety
valve that sets `truncated`.

Do not start the solver until every test in `lib/rules/engine.test.ts` passes
against real seeded data, not just the in-memory fixture.

---

## The interface

Responsive web app: a sidebar on desktop, a bottom tab bar on phones. One
layout (`app/(app)/layout.tsx`) produces both. Navigation is built from the
signed-in role's permissions, so a role never sees a link to something it
cannot open.

Screens: dashboard, schedules (patient and clinician weeks), patients,
clinicians, fill service, authorizations, clinical requirements, capacity,
configuration, audit — plus a mobile "More" menu holding whatever the tab bar
could not fit.

### Where it departs from the reference design

The visual reference fills its bars with diagonal hatching and overlays three
unlabelled curves on an axis-free chart. Both were dropped:

- **No decorative texture.** Dense angled fills read as noise at this size and
  are a vestibular risk. Texture is reserved for the accessibility case
  (forced colours, print), where it carries meaning.
- **Charts carry readable values.** Every figure on screen is also present as
  text, so nothing is reachable only by hovering.

Kept from the reference: the card grid, the rounded frame, the green brand and
the segmented "barcode" stat strips.

### Colour

Two systems, deliberately separate. **Brand green** dresses the chrome and
never identifies a series. **Four categorical hues** identify departments in
charts; every pair clears the colourblind and normal-vision floors in both
light and dark mode, tested against all pairs because a calendar puts arbitrary
services side by side. A fifth department folds into "other" rather than taking
an unvalidated fifth hue.

`--brand` is 5.48:1 against white, which is why it is the same value in both
modes — white button text passes either way.

### Synthetic data

`lib/testing/clinic.ts` builds the §69 roster — 20 patients, 10 RBTs, 3 BCBAs,
3 therapists, 2 OTs, 2 psychologists, 1 neuropsychologist, three clinics — on
top of the acceptance scenario, so John Reyes keeps his exact 27-of-30-hours
setup while the building fills up around him.

Deterministic, and **every generated appointment is re-proved against the real
rule engine** (78 of 78 valid). That check is worth keeping: earlier versions
booked clinicians outside their availability, double-booked rooms, and used
durations the service does not offer — all of which looked fine on screen.

### Known gaps

- Dark-mode tokens are defined and exercised but have not been visually
  reviewed; headless Edge ignored the colour-scheme override.
- Every screen is read-only. Nothing writes, so the audit log is genuinely
  empty.
