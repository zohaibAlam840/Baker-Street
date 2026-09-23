# Front-end demo — what to show Baker Street

Fourteen screens, light theme, responsive. Every figure on screen is computed
by the scheduling engine from the synthetic clinic; nothing is mocked up in
the markup.

## Screens, and the spec section each answers

| Screen | Spec | What it shows |
|---|---|---|
| Dashboard | — | Today at a glance; adapts to the signed-in role |
| Schedules | §46, §53 | Patient and clinician weeks, with availability and school blocks |
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
