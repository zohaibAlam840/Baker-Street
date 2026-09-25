# Front-end demo — what to show Baker Street

Fourteen screens, light theme, responsive. Every figure on screen is computed
by the scheduling engine from the synthetic clinic; nothing is mocked up in
the markup.

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
| Options | §8, §56, §60-62 | Alternative schedules and the approval workflow |
| Simulation | §50-52 | What changes if the practice hires |
| Capacity | §51, §54 | Authorized vs scheduled vs staffable |
| Authorizations | §10 | Payer position, deliberately without clinical targets beside it |
| Clinical | §9 | The four numbers: scheduled, minimum, target, authorized |
| Configuration | §4, §42, §72 | Services as configuration — adding one is rows, not code |
| Audit log | §26 | Honestly empty; nothing writes yet |
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

## The three demo moments

**1. The acceptance question (§77).** Assistant → *"Get John to 30 hours of ABA
this week without moving his OT or therapy."* It parses to a structured
request, shown on screen, then answers: 30 hours reachable, the exact
appointments, and *"no arrangement can do better."*

**2. Explaining a no (§67).** Ask for 40 hours. Instead of "no solution":
only 3h of authorization remain, 3h are held by protected appointments, only
8h where the patient is free and a clinician is available, and school blocks
the mornings — ordered by what is actually binding.

**3. Hiring does not fix it (§51-52).** Simulation → three more RBTs adds 144
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

- Nothing writes. No booking, no approval, no audit entries. Buttons that would
  write are visibly disabled with the reason.
- No CP-SAT solver. Options come from named heuristics, each proved legal by
  the rule engine. A solver would search the space properly.
- Each service is optimised alone; the multi-service trade-off is Phase 2.
- Sign-in is a role switcher, not authentication.
- Every patient and clinician is invented.

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

**Sign-in** is two panels. The left states what the build is — an interactive
prototype of every feature in the specification — and lists the seven roles,
each row a direct way in: initials, name, what the role does, its permission
count. A stat strip closes it (14 screens, 17 hard constraints, 7 roles, 0
decisions made by AI). The right is an ordinary sign-in form: work email,
password, and a  field.

Presenting the roles on the panel rather than as chips under the form was a
client request, and it reads better: the form is a form, and the roles get
room to explain themselves.

The fields are genuine inputs so the design can be judged, but nothing is
verified. That is said once, next to the button — impossible to miss, and
impossible to mistake for a security feature.

**Landing page** runs the full marketing sequence: hero with a live slice of
the real dashboard (not an illustration — the numbers come from the demo
clinic), a stat strip, six capability cards, a three-step "how it works" that
states AI never decides the schedule, the seven roles, the pre-PHI checklist,
and a closing call to action.

### One implementation note

A `<select name="role">` inside a form does reach a server action's FormData,
which is why the sign-in form works. A `<button name>/<value>` does **not** —
that was the earlier bug where every role button failed. The quick-access
chips bind their role into the action instead of relying on the button value.

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
