# Front-end demo — what to show Baker Street

A responsive web/PWA product walkthrough. Scheduling figures are computed by
the same rule engine used by live workflows; they are not hard-coded into the
markup. Use synthetic mode for a safe demo and Supabase-backed mode only with
approved test or production data.

## Screens, and the spec section each answers

| Screen | Spec | What it shows |
|---|---|---|
| Dashboard | — | Today at a glance; adapts to the signed-in role |
| Schedule | §21, §46 | The practice week: every appointment by day, filterable by service |
| Patients | §9 | Caseload, hours, requirements met |
| Clinicians | §11-14, §53 | Availability, credentials, utilization |
| Assistant | §58-59 | Plain English in, structured request out, engine answers |
| Find a time | §48-49 | Ranked legal slots with the score explained |
| Fill service | §43-47 | How close to target, and what is stopping it (§67) |
| Plan optimizer | §8, §56, §60-63 | Bounded multi-service plans and atomic approval |
| Simulation | §50-52 | What changes if the practice hires |
| Capacity | §51, §54 | Authorized vs scheduled vs staffable |
| Authorizations | §10 | Payer position, deliberately without clinical targets beside it |
| Clinical | §9 | The four numbers: scheduled, minimum, target, authorized |
| Configuration | §4, §42, §72 | Services as configuration — adding one is rows, not code |
| Audit log | §26 | Appointment, configuration, approval and override history |
| Settings | §64 | Environment, and a plain list of what is missing |

### Detail pages

| Screen | Spec | What it shows |
|---|---|---|
| Patient record | §9, §15-17, §10 | Stats, requirements vs authorization, the week, availability and what blocks it, preferences, payer authorizations |
| Clinician record | §11-14, §53 | Bookability, utilization, credentials with expiry, service eligibility, working hours, caseload, appointments |

Both enforce scope at the page, not just in navigation: a therapist opening a
patient who is not theirs, or a colleague's record, gets a 404. That was
verified by request, not assumed.

The patient record links straight to Fill service and Find a time for that
patient, so the flow from record to action is one tap.

## The four demo moments

**1. The acceptance question (§77).** Assistant → *"Get John to 30 hours of ABA
this week without moving his OT or therapy."* It parses to a structured
request, shown on screen, then answers: 30 hours reachable, the exact
appointments, and *"no arrangement can do better."*

**2. Compare and approve a complete plan (§56, §60-63).** Open Plan optimizer,
select John and compare the complete patient-week options. Point out the
current-to-projected service metrics, required-care protection, rooms, provider
continuity, and `BOUNDED` disclosure. Approval asks for a reason, reloads live
data, recomputes the selected option, and commits every appointment or none.

**3. Explaining a no (§67).** Ask for 40 hours. Instead of "no solution":
only 3h of authorization remain, 3h are held by protected appointments, only
8h where the patient is free and a clinician is available, and school blocks
the mornings — ordered by what is actually binding.

**4. Hiring does not fix it (§51-52).** Simulation → three more RBTs adds 144
roster hours and **7 hours of delivered care**. The limit is when patients are
free and what their authorizations allow, not headcount. This is the argument
the capacity engine exists to make.

## What to say about the AI

The assistant is a **deterministic parser over fixed phrasings** — no language
model is connected. That is deliberate for this build and the screen says so.
What it demonstrates is the architecture the spec insists on (§59): language
translates a request, the engine decides. Swapping in a real model replaces one
file, `lib/ai/interpret.ts`, and nothing else moves.

## Be straight about

- Authorized workflows do write. Plan approval is human-initiated, recomputed
  from current RLS-scoped data, revalidated in Postgres, and atomic.
- The multi-service optimizer is a deterministic bounded search, not CP-SAT.
  `BOUNDED` and `FEASIBLE` are not claims of global optimality.
- Fill Service is intentionally a separate single-service bounds analysis; Plan
  optimizer is the screen that resolves multiple services together.
- Sign-in uses Supabase Auth. A profile must be active and every page/query is
  constrained by permissions and Postgres row-level security.
- Synthetic mode contains invented people. A live Supabase environment does
  not, so use only approved data and accounts there.

The Settings screen lists all of this, so the client can read it themselves
rather than take it on trust.

## Dashboard layout

Rebuilt to the client's reference:

- **Stat row** — four cards, each with its metric icon in the corner and a
  segmented strip underneath, a different hue per card.
- **Middle row** — Appointment trends (completed/upcoming pills, area chart
  with a floating value pill), Service mix (three smooth lines, legend
  present), and Clinician schedule as a tall card spanning both rows.
- **Clinician schedule** — name and base, a week rail with today filled, hour
  chips for today with booked ones filled, a utilization bar, two counters and
  the day's appointments.
- **Patient demographic** — vertical bars, count above each, share chips below.

### The hatched bars

The reference fills its bars with diagonal hatching and the client asked for
it twice, so the bars carry it. It is kept deliberately gentle: a low-opacity
overlay on a solid fill, with the bar height carrying the value. A dense,
high-contrast field of angled lines vibrates on screen and is a vestibular
risk — that concern was raised, the client decided, and this is the version
that honours the decision without the failure mode.

The called-out column graduates green into yellow rather than mixing the two
into one tone, which produced a muddy olive that read as a third category.

## The assistant widget

A floating launcher sits on every signed-in page — bottom right, clear of the
mobile tab bar and its safe area. It opens a panel with a field and three
example questions; submitting hands off to `/assistant`.

The widget never answers anything itself. There is one place where a sentence
becomes a structured request and the engine replies, and the panel repeats the
same disclosure: no language model is connected.

## Sign-in and landing

**Sign-in** uses real Supabase email/password authentication. The form links to
request-access and forgot-password flows; reset links return through the Auth
callback. A new account remains on the pending screen until an administrator
activates its profile, assigns the approved role, and—when applicable—links the
clinical provider record.

The seven roles are no longer shortcuts around authentication. They are stored
in `user_profiles`, drive permission checks and navigation, and are repeated in
Postgres RLS. Provider and clinical scope comes from the provider/profile link
and active care-team assignments.

**Landing page** runs the full marketing sequence: hero with a live slice of
the real dashboard (not an illustration — the numbers come from the demo
clinic), a stat strip, six capability cards, a three-step "how it works" that
states AI never decides the schedule, the seven roles, the pre-PHI checklist,
and a closing call to action.

### One implementation note

Email confirmation may be disabled for an administrator-approved internal
account flow, but account approval must remain mandatory. Password reset links
must use the production callback URL configured in Supabase Auth.

## Mobile

Every screen was checked at 414px as well as desktop.

- Cards stack; action buttons go full width.
- Wide tables scroll horizontally inside their card rather than squashing.
- The week grid scrolls sideways, with a line of text saying so — a silent
  horizontal scroll is one people do not find.
- The tab bar holds four destinations plus More, at 56px tall.
- The floating assistant sits clear of the tab bar and its safe area, and the
  page has bottom padding on both breakpoints so it never covers the last
  card. That was a real bug: it was obscuring an authorization figure.

## Navigation: one destination per person

Schedules, Patients and Clinicians were three entries that all led to the same
people — and the *same card* went to a calendar from one list and a record
from another. That split was the real problem behind "which should be the
default".

Resolved by giving each one a distinct job:

- **Schedule** — the practice's week. Every appointment by day, with a day
  rail carrying counts and a service filter. It owns *time*.
- **Patients** and **Clinicians** — lists leading to records. They own *people*.

**Records are the canonical destination** everywhere: patient lists, clinician
lists, the dashboard agenda, the assistant's answers, and the schedule rows
all lead to the record. The record already embeds the week grid *plus* the
context needed to act on it — requirements, availability, credentials — so it
is a superset of the calendar view, not a detour.

The focused calendar (`/schedule/patient/[id]`, `/schedule/provider/[id]`)
remains one tap away via "Full schedule view" on each record, for when someone
wants the grid and nothing else.

## The assistant is a chat now

It used to be a launcher: you typed a question, it navigated to `/assistant`,
and the page answered — so asking anything threw away the screen you were on.
It now holds a conversation in place.

- **Bottom-left, on every page.** A launcher on desktop; a sheet above the tab
  bar on a phone.
- **The answer arrives in the thread.** `POST /api/assistant` parses the
  sentence, the engine computes the answer, and the bubble carries the
  figures, the suggested appointments, the blocking constraints, and links to
  the records involved.
- **The conversation survives a reload**, kept in `sessionStorage`.
- **The header says what it is** — "Engine-backed · no language model" — because
  the widget now looks exactly like a chatbot, and that is the one place
  someone could reasonably assume a model is thinking.

### One computation, two surfaces

`lib/ai/answer.ts` turns a parsed request into plain answer data, and
`components/assistant/AnswerView.tsx` renders it. The chat widget and the full
`/assistant` page both use them, so the two cannot drift apart. Previously the
page computed its answer inline and the widget had none of its own.

### Parser fixes found by testing the suggestions

Every phrasing the UI offers as a chip is now covered by a test, which caught
two failures:

- **"Why can't John reach 40 hours?" named no service and failed outright.**
  It now falls back to the service the patient receives most of, and *says so*
  in the answer — assuming silently would be the assistant appearing to know
  something it does not.
- **An unreachable target was not reported as unreachable.** Asking about 40
  hours and being told "can reach 30 hours" reads as though the question was
  misheard. The answer now leads with the shortfall and the engine's reasons.

## Scoping leaks found and closed

Two, both on the dashboard:

- **The compliance officer holds `audit.read` and nothing else**, but the
  dashboard was gated only on having a session — so they landed on patient
  demographics, service mix and a named clinician's week. They now get an
  oversight screen of counts, with nothing that identifies a patient or a
  clinician, and the search box, add-patient shortcut and Reports button are
  hidden for roles that cannot use them.
- **A therapist saw practice-wide patient demographics.** A clinician with one
  patient this week was shown the age spread of all twenty. It is now their
  own cohort.

The pattern in both: least privilege has to hold on the landing screen, not
only on the pages behind a permission check.

## Email and notifications: what actually exists

There is still no transactional email provider or appointment-reminder email
workflow. Supabase Auth may send its own confirmation/reset messages when that
feature is enabled, but the application does not send clinical email.

The application does include an RLS-scoped work queue and optional Web Push:

- Live engine alerts cover credentials, authorizations, clinical minimums, and
  appointments without a clinician.
- Stored `notifications` provide assigned follow-up tasks and read state.
- A user can opt a device into Web Push from Settings. Subscriptions are tied
  to that user and can be disabled from the device.
- Lock-screen payloads are deliberately generic and contain no patient name,
  diagnosis, authorization number, service, or appointment details.

### To add email later

1. An account with a provider (Resend, Postmark, SES).
2. A verified sending domain with SPF, DKIM and DMARC — mail from an
   unverified domain lands in spam.
3. **A signed business associate agreement**, and a rule that appointment
   details never appear in the body. A reminder saying "you have an
   appointment on Tuesday" is fine; one naming the service is a disclosure.
4. An unsubscribe path and a record of consent per recipient.

### Work queue behavior

The bell now works, from data the engine already holds:

- **Lapsed or expiring credentials** — the one condition that makes a *booked*
  appointment illegal, so it sorts first.
- **Authorizations running out**, and funded hours nobody has scheduled.
- **Patients below their clinical minimum** — a clinical floor, not a payer
  figure.
- **Appointments with no clinician.**

Engine alerts are computed from the current snapshot each time the work queue
opens. Assigned tasks are stored separately, and a push notification is only a
generic prompt to open the authenticated work queue; the protected details
remain inside the application.

Two decisions worth noting:

- **Grouping runs after scoping, never before.** Every ABA authorization in
  the demo clinic ends on the same date, which produced sixteen near-identical
  rows; they now collapse into one. But a therapist who can see one of those
  patients gets that patient *by name* — collapsing first would have hidden a
  name behind a count of people who are none of their business.
- **The badge only counts things that are actually wrong.** Padding it with
  read receipts is how people learn to ignore a notification light.

### The search box searches

`/search` covers patients, clinicians and appointments — the three its
placeholder had been promising — scoped so a therapist finds their own
patients and themselves and nobody else. It reads the same snapshot every
other screen does, so there is no index to fall out of date. It is also in the
nav, because the top-bar box is desktop-only and a phone had no way to reach
it.
