import Link from "next/link";

import { ROLES, ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const session = await getSession();

  return (
    <div className="min-h-full">
      <header className="border-b border-[var(--rule-hairline)] bg-[var(--surface-1)]">
        <div className="mx-auto flex max-w-[72rem] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <span className="text-sm font-semibold text-[var(--ink-primary)]">
            Baker Street Scheduling
          </span>
          {session ? (
            <Link
              href={ROLE_DEFINITIONS[session.role].home}
              className="rounded-md bg-[var(--dept-1)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Continue as {ROLE_DEFINITIONS[session.role].label}
            </Link>
          ) : (
            <Link
              href="/login"
              className="rounded-md bg-[var(--dept-1)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[72rem] px-4 sm:px-6">
        {/* Hero */}
        <section className="py-16 sm:py-24">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
            Multi-service clinical scheduling
          </p>
          <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-[var(--ink-primary)] sm:text-4xl">
            Every service a patient needs, scheduled together.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--ink-secondary)]">
            ABA, therapy, occupational therapy and the rest compete for the same
            patients, the same clinicians and the same rooms. This engine
            schedules them as one problem — respecting credentials, school
            hours, room capacity and what the payer actually authorized — and
            tells you plainly when something is not possible.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/login"
              className="rounded-md bg-[var(--dept-1)] px-4 py-2 text-sm font-medium text-white"
            >
              {session ? "Switch role" : "Sign in"}
            </Link>
            <Link
              href={session ? "/schedule" : "/login"}
              className="rounded-md border border-[var(--border-ring)] px-4 py-2 text-sm font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-sunken)]"
            >
              See a sample week
            </Link>
          </div>

          <p className="mt-6 flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full"
              style={{ background: "var(--status-warning)" }}
            />
            Phase 1 preview — synthetic data, no real patient information, and
            sign-in is a role switcher rather than real authentication.
          </p>
        </section>

        {/* What it does */}
        <section className="border-t border-[var(--rule-hairline)] py-14">
          <h2 className="text-sm font-medium text-[var(--ink-primary)]">
            What it does today
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Capability
              title="Knows every reason a booking is illegal"
              body="Double-booked patient or clinician, lapsed certification, school hours, room at capacity, over the authorization, not enough time to drive between clinics. Seventeen rules, each returning a reason rather than a refusal."
            />
            <Capability
              title="Finds the time that actually exists"
              body="Ranked openings across every eligible clinician, weighted by who the patient already sees, where they prefer to be seen, and whether the slot leaves a useless gap in the day."
            />
            <Capability
              title="Answers the hours question"
              body="“Get this patient as close to 30 hours as possible without losing therapy or OT.” It reports what is reachable, proposes the appointments, and says whether a better arrangement could exist."
            />
            <Capability
              title="Explains itself when the answer is no"
              body="Not “no solution”. Instead: only 3h of authorization remain, 3h are held by protected appointments, and there are only 8h where the patient is free and a clinician is available."
            />
            <Capability
              title="Keeps authorization and clinical need apart"
              body="What the payer will fund and what the patient clinically needs are different numbers, held by different people. The system refuses to let one quietly become the other."
            />
            <Capability
              title="Never lets the AI decide"
              body="The constraint engine determines what is legal and what is best. AI is only ever an interface: understanding a request in plain English, and explaining the answer back."
            />
          </div>
        </section>

        {/* Roles */}
        <section className="border-t border-[var(--rule-hairline)] py-14">
          <h2 className="text-sm font-medium text-[var(--ink-primary)]">
            Built around who does the work
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--ink-secondary)]">
            Seven roles, each holding the operations that genuinely belong to
            it. A scheduler cannot change what a patient clinically needs; the
            person entering authorizations cannot either. That separation is
            deliberate.
          </p>

          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ROLES.map((role) => {
              const definition = ROLE_DEFINITIONS[role];
              return (
                <li
                  key={role}
                  className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4"
                >
                  <div className="text-sm font-medium text-[var(--ink-primary)]">
                    {definition.label}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--ink-secondary)]">
                    {definition.summary}
                  </p>
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    {definition.permissions.length}{" "}
                    {definition.permissions.length === 1 ? "permission" : "permissions"} ·
                    approx. {definition.headcount} people
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
      </main>

      <footer className="border-t border-[var(--rule-hairline)] py-8">
        <div className="mx-auto max-w-[72rem] px-4 text-xs text-[var(--ink-muted)] sm:px-6">
          Baker Street Health · scheduling and capacity engine · Phase 1
        </div>
      </footer>
    </div>
  );
}

function Capability({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4">
      <h3 className="text-sm font-medium text-[var(--ink-primary)]">{title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-[var(--ink-secondary)]">{body}</p>
    </div>
  );
}
