import Link from "next/link";

import { SegmentBar } from "@/components/charts";
import { ChatPreview } from "@/components/landing/ChatPreview";
import {
  IconArrowUpRight,
  IconCalendar,
  IconChart,
  IconClipboard,
  IconLogo,
  IconShield,
  IconSpark,
  IconStethoscope,
  IconUsers,
} from "@/components/shell/icons";
import { answerQuestion } from "@/lib/ai/answer";
import { interpret } from "@/lib/ai/interpret";
import { ROLES, ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { loadPublicDemoHorizon } from "@/lib/data/snapshot";
import { slotsToHours } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const session = await getSession();

  // Real numbers from the demo clinic. A landing page with invented figures
  // beside a product that computes real ones would be the odd thing.
  // The landing page is a public product tour. Its figures come from the
  // documented synthetic clinic, never from rows visible to the current
  // cookie. This also keeps pending, disabled and stale sessions from making
  // the public home page fail while RLS correctly withholds clinical data.
  const { ctx } = loadPublicDemoHorizon({ startDate: defaultWeekStart() });
  const patients = [...ctx.patients.values()];
  const activePatients = patients.filter((p) => p.status === "ACTIVE").length;
  const clinicians = [...ctx.providers.values()].length;
  const appointments = ctx.appointments.length;
  const hours = Math.round(
    ctx.appointments.reduce(
      (total, a) => total + slotsToHours(a.range.endSlot - a.range.startSlot),
      0,
    ),
  );

  /**
   * The transcript on the assistant panel below is played out, not written:
   * these are the parser and the engine answering three real questions about
   * the demo clinic, at request time. If the fixture changes, the landing
   * page changes with it.
   */
  const transcript = [
    "Get John to 30 hours of ABA this week without moving his OT or therapy",
    "How much unused authorization do we have?",
    "What happens if we hire three more RBTs?",
  ].map((question) => {
    const answer = answerQuestion(ctx, interpret(question, ctx));
    return {
      user: question,
      assistant: answer.summary,
      stats: answer.stats.slice(0, 2),
    };
  });

  const signedInHref = session ? ROLE_DEFINITIONS[session.role].home : "/login";
  const signedInLabel = session
    ? `Continue as ${ROLE_DEFINITIONS[session.role].label}`
    : "Sign in";

  return (
    <div className="min-h-dvh bg-[var(--surface-page)]">
      {/* ------------------------------- nav ------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-[var(--rule-hairline)] bg-[var(--surface-page)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-[76rem] items-center gap-6 px-5 py-3.5 sm:px-8">
          <Link href="/" className="flex items-center gap-2">
            <IconLogo className="size-7 text-[var(--brand)]" />
            <span className="text-[0.95rem] font-semibold tracking-tight text-[var(--ink-primary)]">
              Baker Street
            </span>
          </Link>

          <nav className="hidden items-center gap-6 md:flex">
            {[
              ["What it does", "#features"],
              ["How it works", "#how"],
              ["Assistant", "#assistant"],
              ["Roles", "#roles"],
              ["Security", "#security"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="text-sm text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)]"
              >
                {label}
              </a>
            ))}
          </nav>

          <Link
            href={signedInHref}
            className="ml-auto rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
          >
            {signedInLabel}
          </Link>
        </div>

        {/* The section links, for phones — they were desktop-only, which left
            a mobile visitor with one button and a long scroll. */}
        <nav className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto border-t border-[var(--rule-hairline)] px-5 py-2.5 sm:px-8 md:hidden">
          {[
            ["What it does", "#features"],
            ["How it works", "#how"],
            ["Assistant", "#assistant"],
            ["Roles", "#roles"],
            ["Security", "#security"],
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="whitespace-nowrap rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-1.5 text-xs text-[var(--ink-secondary)]"
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <main>
        {/* ------------------------------ hero ------------------------------ */}
        <section className="mx-auto max-w-[76rem] px-5 pb-10 pt-14 sm:px-8 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-1.5 text-xs text-[var(--ink-secondary)]">
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: "var(--brand)" }}
                />
                Multi-service clinical scheduling
              </span>

              <h1 className="mt-5 max-w-xl text-4xl font-semibold leading-[1.1] tracking-tight text-[var(--ink-primary)] sm:text-5xl">
                Every service a patient needs,{" "}
                <span className="text-[var(--brand)]">scheduled together.</span>
              </h1>

              <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--ink-secondary)]">
                ABA, therapy, occupational therapy and the rest compete for the
                same patients, the same clinicians and the same rooms. This
                engine schedules them as one problem — respecting credentials,
                school hours, room capacity and what the payer actually
                authorized — and tells you plainly when something is not
                possible.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href={signedInHref}
                  className="rounded-full bg-[var(--brand)] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
                >
                  {session ? "Open the app" : "Explore the demo"}
                </Link>
                <a
                  href="#how"
                  className="rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-5 py-3 text-sm font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-sunken)]"
                >
                  See how it works
                </a>
              </div>

              <p className="mt-6 flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: "var(--status-warning)" }}
                />
                Preview build — synthetic scheduling data, no real patient information,
                and access is protected by Supabase Auth and database roles.
              </p>
            </div>

            {/* A slice of the real product, not an illustration. */}
            <div className="relative">
              <div
                aria-hidden
                className="absolute -inset-6 -z-10 rounded-[2rem] opacity-60 blur-2xl"
                style={{
                  background:
                    "radial-gradient(60% 60% at 70% 30%, color-mix(in srgb, var(--brand) 26%, transparent) 0%, transparent 70%)",
                }}
              />

              <div className="card overflow-hidden p-0">
                <div className="flex items-center gap-1.5 border-b border-[var(--rule-hairline)] bg-[var(--surface-app)] px-4 py-2.5">
                  <span className="size-2.5 rounded-full bg-[var(--rule-strong)]" />
                  <span className="size-2.5 rounded-full bg-[var(--rule-strong)]" />
                  <span className="size-2.5 rounded-full bg-[var(--rule-strong)]" />
                  <span className="ml-3 text-[0.6875rem] text-[var(--ink-muted)]">
                    Overview
                  </span>
                </div>

                <div className="space-y-3 bg-[var(--surface-app)] p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="card p-3.5">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-[0.6875rem] text-[var(--ink-secondary)]">
                            Total patients
                          </div>
                          <div className="mt-0.5 text-xl font-semibold text-[var(--ink-primary)]">
                            {patients.length}
                          </div>
                        </div>
                        <span
                          aria-hidden
                          className="grid size-7 place-items-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-secondary)]"
                        >
                          <IconUsers className="size-3.5" />
                        </span>
                      </div>
                      <div className="mt-2.5">
                        <SegmentBar
                          value={activePatients}
                          total={patients.length}
                          leftLabel="Active"
                          rightLabel="Inactive"
                          leftValue={String(activePatients)}
                          rightValue={String(patients.length - activePatients)}
                          ticks={26}
                        />
                      </div>
                    </div>

                    <div className="card p-3.5">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-[0.6875rem] text-[var(--ink-secondary)]">
                            Clinicians
                          </div>
                          <div className="mt-0.5 text-xl font-semibold text-[var(--ink-primary)]">
                            {clinicians}
                          </div>
                        </div>
                        <span
                          aria-hidden
                          className="grid size-7 place-items-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-secondary)]"
                        >
                          <IconStethoscope className="size-3.5" />
                        </span>
                      </div>
                      <div className="mt-2.5">
                        <SegmentBar
                          value={clinicians - 1}
                          total={clinicians}
                          leftLabel="Available"
                          rightLabel="On leave"
                          leftValue={String(clinicians - 1)}
                          rightValue="1"
                          color="var(--dept-1)"
                          ticks={26}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="card p-3.5">
                    <div className="flex items-baseline justify-between">
                      <div className="text-[0.6875rem] text-[var(--ink-secondary)]">
                        This week
                      </div>
                      <span className="text-[0.6875rem] text-[var(--brand)]">
                        {hours}h delivered
                      </span>
                    </div>
                    <div className="mt-1 text-xl font-semibold text-[var(--ink-primary)]">
                      {appointments} appointments
                    </div>

                    {/* The answer the product exists to give. */}
                    <div className="mt-3 rounded-xl bg-[var(--brand-tint)] p-3">
                      <p className="text-[0.6875rem] leading-relaxed text-[var(--ink-primary)]">
                        <span className="font-semibold">John can reach 30 hours</span>{" "}
                        this week — an extra 3h across 2 appointments. No
                        arrangement can do better.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------ stats ------------------------------ */}
        <section className="mx-auto max-w-[76rem] px-5 py-10 sm:px-8">
          <dl className="grid gap-px overflow-hidden rounded-2xl border border-[var(--border-ring)] bg-[var(--rule-hairline)] sm:grid-cols-4">
            {[
              ["17", "hard constraints enforced"],
              ["15 min", "scheduling granularity"],
              ["7", "roles, each scoped"],
              ["0", "decisions made by AI"],
            ].map(([value, label]) => (
              <div key={label} className="bg-[var(--surface-1)] px-5 py-6 text-center">
                <dt className="sr-only">{label}</dt>
                <dd>
                  <span className="block text-2xl font-semibold text-[var(--ink-primary)]">
                    {value}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--ink-secondary)]">
                    {label}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ----------------------------- features ---------------------------- */}
        <section id="features" className="scroll-mt-24 mx-auto max-w-[76rem] px-5 py-14 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
            What it does today
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--ink-secondary)]">
            Every figure in the product is computed by the scheduling engine —
            nothing on these screens is decoration.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: <IconShield className="size-[18px]" />,
                title: "Knows every reason a booking is illegal",
                body: "Double-booked patient or clinician, lapsed certification, school hours, room at capacity, over the authorization, not enough time to drive between clinics. Seventeen rules, each returning a reason rather than a refusal.",
              },
              {
                icon: <IconCalendar className="size-[18px]" />,
                title: "Finds the time that actually exists",
                body: "Ranked openings across every eligible clinician, weighted by who the patient already sees, where they prefer to be seen, and whether the slot leaves a useless gap in the day.",
              },
              {
                icon: <IconSpark className="size-[18px]" />,
                title: "Answers the hours question",
                body: "“Get this patient as close to 30 hours as possible without losing therapy or OT.” It reports what is reachable, proposes the appointments, and says whether a better arrangement could exist.",
              },
              {
                icon: <IconClipboard className="size-[18px]" />,
                title: "Explains itself when the answer is no",
                body: "Not “no solution”. Instead: only 3h of authorization remain, 3h are held by protected appointments, and there are only 8h where the patient is free and a clinician is available.",
              },
              {
                icon: <IconChart className="size-[18px]" />,
                title: "Shows what hiring would actually buy",
                body: "Three more clinicians adds roster hours — but only the hours that land where patients are free and authorization remains count as care delivered. The simulation reports both.",
              },
              {
                icon: <IconUsers className="size-[18px]" />,
                title: "Keeps authorization and clinical need apart",
                body: "What the payer will fund and what the patient clinically needs are different numbers, held by different people. The system refuses to let one quietly become the other.",
              },
            ].map((feature) => (
              <article key={feature.title} className="card p-5">
                <span
                  aria-hidden
                  className="grid size-10 place-items-center rounded-xl bg-[var(--brand-tint)] text-[var(--brand)]"
                >
                  {feature.icon}
                </span>
                <h3 className="mt-4 text-sm font-semibold text-[var(--ink-primary)]">
                  {feature.title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[var(--ink-secondary)]">
                  {feature.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* ---------------------------- how it works -------------------------- */}
        <section id="how" className="scroll-mt-24 border-y border-[var(--rule-hairline)] bg-[var(--surface-1)]">
          <div className="mx-auto max-w-[76rem] px-5 py-14 sm:px-8">
            <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
              How it works
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--ink-secondary)]">
              The constraint engine decides what is legal and what is best. AI is
              only ever an interface.
            </p>

            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {[
                {
                  step: "01",
                  title: "Ask in plain English",
                  body: "“Get John to 30 hours of ABA without moving his OT.” The assistant turns the sentence into a structured scheduling request — and shows you exactly what it understood.",
                },
                {
                  step: "02",
                  title: "The engine decides",
                  body: "Candidates are generated, every hard rule is applied, and the result is bracketed: what is reachable, and whether a better arrangement could exist.",
                },
                {
                  step: "03",
                  title: "A human approves",
                  body: "Options are offered with their trade-offs — more hours against fewer changes. Approving locks, revalidates against live data, commits atomically and writes an audit entry.",
                },
              ].map((item) => (
                <li key={item.step}>
                  <span className="text-xs font-semibold tabular-nums text-[var(--brand)]">
                    {item.step}
                  </span>
                  <h3 className="mt-2 text-sm font-semibold text-[var(--ink-primary)]">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-[var(--ink-secondary)]">
                    {item.body}
                  </p>
                </li>
              ))}
            </ol>

            <p className="mt-8 rounded-2xl bg-[var(--surface-sunken)] p-4 text-xs leading-relaxed text-[var(--ink-secondary)]">
              <span className="font-medium text-[var(--ink-primary)]">
                AI never decides the schedule.
              </span>{" "}
              It cannot invent availability, judge whether a schedule is legal,
              book anything, or override an authorization or a credential. Those
              belong to the engine, and always will.
            </p>
          </div>
        </section>

        {/* ---------------------------- assistant ---------------------------- */}
        <section id="assistant" className="scroll-mt-24 mx-auto max-w-[76rem] px-5 py-14 sm:px-8">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr]">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-1.5 text-xs text-[var(--ink-secondary)]">
                <IconSpark className="size-3.5 text-[var(--brand)]" />
                In every corner of the app
              </span>

              <h2 className="mt-5 text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
                A chat that can only tell you the truth
              </h2>

              <p className="mt-4 text-sm leading-relaxed text-[var(--ink-secondary)]">
                Ask about a patient&rsquo;s hours, spare capacity, or what
                another hire would buy you — from wherever you are, without
                leaving the screen you were working on. The assistant sits in
                the bottom-left corner of every page.
              </p>

              <ul className="mt-6 space-y-3">
                {[
                  [
                    "It cannot make a number up",
                    "The sentence becomes a structured request; the scheduling engine computes every figure. Nothing is generated.",
                  ],
                  [
                    "It shows its working",
                    "How long the engine took, how many candidate appointments it weighed, and whether a better arrangement could exist.",
                  ],
                  [
                    "It cannot book anything",
                    "Answers and proposals only. Committing a schedule is a human decision with an audit entry behind it.",
                  ],
                ].map(([title, body]) => (
                  <li key={title} className="flex gap-3">
                    <span
                      aria-hidden
                      className="mt-1.5 size-1.5 shrink-0 rounded-full"
                      style={{ background: "var(--brand)" }}
                    />
                    <span>
                      <span className="block text-sm font-medium text-[var(--ink-primary)]">
                        {title}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-[var(--ink-secondary)]">
                        {body}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-6 rounded-xl bg-[var(--surface-sunken)] p-3.5 text-xs leading-relaxed text-[var(--ink-secondary)]">
                <span className="font-medium text-[var(--ink-primary)]">
                  No language model is connected in this build.
                </span>{" "}
                A fixed-phrase parser recognises the question and the engine
                answers it. That boundary is the architecture the specification
                asks for — a model, when one is added, replaces the parser and
                nothing else.
              </p>
            </div>

            {/* Real answers, computed above at request time. */}
            <ChatPreview script={transcript} />
          </div>
        </section>

        {/* ------------------------------ roles ------------------------------ */}
        <section id="roles" className="scroll-mt-24 mx-auto max-w-[76rem] px-5 py-14 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
            Built around who does the work
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--ink-secondary)]">
            Seven roles, each holding the operations that genuinely belong to it.
            A scheduler cannot change what a patient clinically needs; the person
            entering authorizations cannot either. That separation is deliberate.
          </p>

          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role) => {
              const definition = ROLE_DEFINITIONS[role];
              return (
                <li key={role} className="card p-4">
                  <div className="text-sm font-medium text-[var(--ink-primary)]">
                    {definition.label}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--ink-secondary)]">
                    {definition.summary}
                  </p>
                  <p className="mt-3 text-[0.6875rem] text-[var(--ink-muted)]">
                    {definition.permissions.length}{" "}
                    {definition.permissions.length === 1 ? "permission" : "permissions"} ·{" "}
                    {definition.scope === "own"
                      ? "own schedule"
                      : definition.scope === "caseload"
                        ? "own caseload"
                        : "whole practice"}
                  </p>
                </li>
              );
            })}
          </ul>

          <p className="mt-6 text-xs text-[var(--ink-secondary)]">
            This role model is a proposal for Baker Street to confirm — the
            handoff specification requires role-based access but never says what
            the roles are.
          </p>
        </section>

        {/* ----------------------------- security ---------------------------- */}
        <section id="security" className="scroll-mt-24 border-t border-[var(--rule-hairline)] bg-[var(--surface-1)]"
        >
          <div className="mx-auto max-w-[76rem] px-5 py-14 sm:px-8">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr]">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
                  Before any real patient data
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
                  This build runs entirely on invented data, and it says so on
                  every screen. Five things have to be in place before that
                  changes — listed here rather than buried, because a preview
                  that hides its gaps gets mistaken for a finished product.
                </p>
              </div>

              <ol className="space-y-3">
                {[
                  "Real sign-in, ideally the practice's existing identity provider",
                  "Roles read from the database rather than chosen from a menu",
                  "Row-level security in Postgres, so a query bug cannot leak a record",
                  "A paid database plan and a signed business associate agreement",
                  "Encryption in transit and at rest, with audited access",
                ].map((item, index) => (
                  <li key={item} className="flex gap-3.5 rounded-xl bg-[var(--surface-app)] p-3.5">
                    <span className="text-xs tabular-nums text-[var(--ink-muted)]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                      {item}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* ------------------------------- cta ------------------------------- */}
        <section className="mx-auto max-w-[76rem] px-5 py-16 sm:px-8">
          <div
            className="relative overflow-hidden rounded-[1.75rem] p-10 sm:p-14"
            style={{
              background:
                "linear-gradient(140deg, var(--brand) 0%, color-mix(in srgb, var(--brand) 80%, black) 60%, #04211a 100%)",
            }}
          >
            <span
              aria-hidden
              className="absolute -right-20 -top-20 size-80 rounded-full opacity-25"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--dept-2) 70%, white) 0%, transparent 65%)",
              }}
            />
            <div className="relative max-w-xl">
              <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                See a week that actually resolves.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-white/80">
                Twenty patients, twenty-one clinicians, three clinics, and one
                question the engine answers exactly: can this patient reach
                thirty hours without losing anything they need?
              </p>
              <Link
                href={signedInHref}
                className="mt-7 inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-medium text-[var(--ink-primary)] transition-opacity hover:opacity-90"
              >
                {session ? "Open the app" : "Explore the demo"}
                <IconArrowUpRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--rule-hairline)]">
        <div className="mx-auto flex max-w-[76rem] flex-wrap items-center justify-between gap-3 px-5 py-8 sm:px-8">
          <span className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
            <IconLogo className="size-5 text-[var(--brand)]" />
            Baker Street Health · scheduling and capacity engine
          </span>
          <span className="text-xs text-[var(--ink-muted)]">
            Preview build · synthetic data only
          </span>
        </div>
      </footer>
    </div>
  );
}
