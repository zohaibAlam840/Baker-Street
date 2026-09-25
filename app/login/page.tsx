import Link from "next/link";

import { IconLogo } from "@/components/shell/icons";
import { signInFromForm } from "@/lib/auth/actions";
import { ROLES, ROLE_DEFINITIONS, type Role } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * Sign in.
 *
 * Two panels. The left states what this build is — a working prototype of
 * every feature in the specification — and lists the seven roles, each one a
 * direct way in. The right is an ordinary sign-in form, so the design can be
 * judged as a sign-in page rather than a role picker.
 *
 * The fields are genuine inputs but nothing is verified. That is said once,
 * next to the button: impossible to miss, impossible to mistake for a
 * security feature.
 */

/** A plausible work address per role, so the form reads as filled in. */
const DEMO_EMAIL: Record<Role, string> = {
  SCHEDULER: "sam.okonjo@bakerstreet.health",
  CLINICAL: "eve.nakamura@bakerstreet.health",
  PROVIDER: "alice.moreau@bakerstreet.health",
  AUTHORIZATION: "lena.fischer@bakerstreet.health",
  OPERATIONS: "marcus.webb@bakerstreet.health",
  ADMIN: "jo.tanaka@bakerstreet.health",
  COMPLIANCE: "ruth.adeyemi@bakerstreet.health",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; role?: string }>;
}) {
  const { error, role } = await searchParams;
  const selected: Role =
    role && (ROLES as readonly string[]).includes(role) ? (role as Role) : "SCHEDULER";

  return (
    <div className="min-h-dvh bg-[var(--surface-page)] lg:p-4">
      <div className="mx-auto grid min-h-dvh max-w-[90rem] overflow-hidden bg-[var(--surface-1)] lg:min-h-[calc(100dvh-2rem)] lg:grid-cols-[1.05fr_1fr] lg:rounded-[1.75rem] lg:shadow-[var(--shadow-float)]">
        {/* --------------------- left: what this is, and the roles --------------------- */}
        <div
          className="relative order-2 overflow-hidden px-6 py-10 sm:px-10 lg:order-1 lg:px-12 lg:py-12"
          style={{
            background:
              "linear-gradient(155deg, var(--brand) 0%, color-mix(in srgb, var(--brand) 76%, black) 58%, #04211a 100%)",
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute -right-28 -top-28 size-[26rem] rounded-full opacity-25"
            style={{
              background:
                "radial-gradient(circle, color-mix(in srgb, var(--dept-2) 70%, white) 0%, transparent 65%)",
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-36 -left-24 size-[24rem] rounded-full opacity-20"
            style={{ background: "radial-gradient(circle, #ffffff 0%, transparent 62%)" }}
          />

          <div className="relative flex h-full flex-col">
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white/12 px-3 py-1.5 text-xs font-medium text-white">
              <span
                aria-hidden
                className="inline-block size-1.5 rounded-full"
                style={{ background: "var(--dept-2)" }}
              />
              Interactive prototype
            </span>

            <h2 className="mt-5 max-w-md text-2xl font-semibold leading-tight tracking-tight text-white sm:text-[1.75rem]">
              Every feature in the specification, working.
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-white/80">
              Scheduling, conflict detection, availability search, fill service,
              capacity, hiring simulation and the assistant — all running on an
              invented clinic of 20 patients and 21 clinicians. Pick a role
              below to see the product as that person sees it.
            </p>

            {/* The roles, given room rather than crammed under the form. */}
            <div className="mt-8 flex-1">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-white/60">
                Sign in as any role
              </p>

              {/*
                These rows *select* a role rather than signing in on the spot.
                Before, the left panel signed you in instantly while the right
                panel had its own role menu — two ways in, disagreeing, and the
                email field on the right never changed because nothing ever set
                the selection. Now the left says who you are and the right signs
                you in, which is also the shape a real identity provider takes.
              */}
              <ul className="mt-3 space-y-0.5">
                {ROLES.map((value) => {
                  const definition = ROLE_DEFINITIONS[value];
                  const active = value === selected;
                  return (
                    <li key={value}>
                      <Link
                        href={`/login?role=${value}#sign-in`}
                        aria-current={active ? "true" : undefined}
                        className={[
                          "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                          active ? "bg-white/15" : "hover:bg-white/10",
                        ].join(" ")}
                      >
                        <span
                          aria-hidden
                          className={[
                            "grid size-9 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold",
                            active ? "bg-white text-[var(--brand)]" : "bg-white/12 text-white",
                          ].join(" ")}
                        >
                          {/* Skip separators, or "Therapist / provider"
                              initialises to "T/". */}
                          {definition.label
                            .split(/[\s/]+/)
                            .filter((part) => /[a-z]/i.test(part))
                            .map((part) => part[0]!.toUpperCase())
                            .slice(0, 2)
                            .join("")}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-white">
                            {definition.label}
                          </span>
                          <span className="block truncate text-xs text-white/65">
                            {definition.summary}
                          </span>
                        </span>

                        <span className="hidden shrink-0 text-[0.6875rem] text-white/50 sm:block">
                          {definition.permissions.length}{" "}
                          {definition.permissions.length === 1
                            ? "permission"
                            : "permissions"}
                        </span>

                        <span
                          aria-hidden
                          className={[
                            "grid size-5 shrink-0 place-items-center rounded-full border text-[0.625rem]",
                            active
                              ? "border-white bg-white text-[var(--brand)]"
                              : "border-white/30 text-transparent",
                          ].join(" ")}
                        >
                          ✓
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-3 px-3 text-xs text-white/55">
                Selected: {ROLE_DEFINITIONS[selected].label}. Sign in on the
                {" "}
                <a href="#sign-in" className="underline underline-offset-4">
                  form
                </a>{" "}
                to continue as them.
              </p>
            </div>

            <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4 border-t border-white/15 pt-6">
              {[
                ["14", "screens"],
                ["17", "hard constraints"],
                ["7", "roles, each scoped"],
                ["0", "decisions made by AI"],
              ].map(([value, label]) => (
                <div key={label}>
                  <div className="text-lg font-semibold text-white">{value}</div>
                  <div className="text-xs text-white/60">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ------------------------------ right: the form ------------------------------ */}
        <div className="order-1 flex flex-col px-6 py-8 sm:px-10 lg:order-2 lg:px-14 lg:py-10">
          <Link href="/" className="flex items-center gap-2">
            <IconLogo className="size-7 text-[var(--brand)]" />
            <span className="text-[0.95rem] font-semibold tracking-tight text-[var(--ink-primary)]">
              Baker Street
            </span>
          </Link>

          <div className="flex flex-1 flex-col justify-center py-10">
            <div className="mx-auto w-full max-w-sm">
              <h1 id="sign-in" className="scroll-mt-8 text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
                Sign in
              </h1>
              <p className="mt-1.5 text-sm text-[var(--ink-secondary)]">
                Scheduling and capacity for Baker Street Health.
              </p>

              {error === "unknown-role" && (
                <p
                  className="mt-5 rounded-xl px-3 py-2.5 text-sm"
                  style={{
                    background: "color-mix(in srgb, var(--status-critical) 10%, transparent)",
                    color: "var(--status-critical)",
                  }}
                >
                  That role does not exist. Pick one from the list.
                </p>
              )}

              <form action={signInFromForm} className="mt-7 space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">
                    Work email
                  </span>
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    defaultValue={DEMO_EMAIL[selected]}
                    className={field}
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 flex items-baseline justify-between">
                    <span className="text-xs font-medium text-[var(--ink-secondary)]">
                      Password
                    </span>
                    <span className="text-xs text-[var(--ink-muted)]">Forgot?</span>
                  </span>
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    defaultValue="demo-access"
                    className={field}
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">
                    Sign in as
                  </span>
                  <select name="role" defaultValue={selected} className={field}>
                    {ROLES.map((value) => (
                      <option key={value} value={value}>
                        {ROLE_DEFINITIONS[value].label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1.5 block text-xs leading-relaxed text-[var(--ink-muted)]">
                    Sees{" "}
                    {ROLE_DEFINITIONS[selected].scope === "own"
                      ? "their own schedule"
                      : ROLE_DEFINITIONS[selected].scope === "caseload"
                        ? "their own caseload"
                        : "the whole organisation"}
                    .
                  </span>
                </label>

                <button
                  type="submit"
                  className="mt-2 h-11 w-full rounded-full bg-[var(--brand)] text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
                >
                  Sign in
                </button>
              </form>

              {/* Said once, next to the button, where it cannot be missed. */}
              <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-[var(--ink-secondary)]">
                <span
                  aria-hidden
                  className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                  style={{ background: "var(--status-warning)" }}
                />
                <span>
                  <span className="font-medium text-[var(--ink-primary)]">
                    Credentials are not checked.
                  </span>{" "}
                  This is a preview — the role you pick is the only thing that
                  matters, and no real patient data is behind it.
                </span>
              </p>
            </div>
          </div>

          <p className="text-xs text-[var(--ink-muted)]">
            Baker Street Health ·{" "}
            <Link href="/" className="underline underline-offset-4">
              About this preview
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

const field =
  "h-11 w-full rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 text-sm text-[var(--ink-primary)] outline-none placeholder:text-[var(--ink-muted)] focus:border-transparent focus:ring-2 focus:ring-[var(--brand-ring)]";
