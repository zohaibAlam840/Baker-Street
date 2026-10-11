import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/data/snapshot";
import { SCHEDULING_TIMEZONE } from "@/lib/scheduling/defaults";
import { PushNotifications } from "@/components/settings/PushNotifications";

export const dynamic = "force-dynamic";

/**
 * Settings, and an honest statement of what this build is.
 *
 * The readiness list is here rather than buried in a document because a demo
 * that does not say what is missing gets mistaken for a finished product.
 */
export default async function SettingsPage() {
  const session = await requireSession();
  const definition = ROLE_DEFINITIONS[session.role];
  const liveData = isSupabaseConfigured();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Settings
        </h1>
        <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
          Your account and this environment.
        </p>
      </div>

      <PushNotifications />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <dl className="mt-4 space-y-3">
            <Row label="Signed in as" value={session.name} />
            <Row label="Role" value={definition.label} />
            <Row
              label="Sees"
              value={
                definition.scope === "own"
                  ? "Own schedule only"
                  : definition.scope === "caseload"
                    ? "Own caseload"
                    : "Whole organisation"
              }
            />
            <Row label="Permissions" value={String(definition.permissions.length)} />
          </dl>
          <Link
            href="/login"
            className="mt-4 inline-block rounded-full border border-[var(--border-ring)] px-4 py-2 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-sunken)]"
          >
            Switch role
          </Link>
        </Card>

        <Card>
          <CardHeader title="Environment" />
          <dl className="mt-4 space-y-3">
            <Row label="Data source" value={liveData ? "Supabase" : "Synthetic"} />
            <Row label="Timezone" value={SCHEDULING_TIMEZONE} />
            <Row label="Scheduling grid" value="15-minute slots" />
            <Row label="Authentication" value="Supabase Auth" />
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-[var(--ink-secondary)]">
            {liveData
              ? "Connected to a live database."
              : "No database is connected. Every patient, clinician and appointment on screen is invented."}
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="What this build does"
          sub="Phase 1 of the specification"
        />
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {[
            "22-table schema covering patients, services, clinicians, rooms and authorizations",
            "Seventeen hard-constraint rules, each returning a reason rather than a refusal",
            "Ranked availability search with an explained score",
            "Candidate generation — the exact input a CP-SAT solver consumes",
            "Fill Service analysis with upper and lower bounds",
            "Infeasibility explanations ordered by what is actually binding",
            "Hiring and what-if simulation against an in-memory copy",
            "Role-based access with seven roles and scoped data",
          ].map((item) => (
            <li key={item} className="flex gap-2.5">
              <span
                aria-hidden
                className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                style={{ background: "var(--status-good)" }}
              />
              <span className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                {item}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="What it does not do yet"
          sub="Stated plainly, so nothing here is mistaken for finished"
        />
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {[
            "No CP-SAT solver — options come from heuristics, not a proved optimum",
            "No multi-service trade-off: each service is optimised on its own",
            "No native iOS or Android package; the mobile experience is an installable PWA",
            "No billing claim submission or electronic health-record integration",
            "No language model — the assistant is a fixed-phrase parser",
            "No billing or revenue data of any kind",
          ].map((item) => (
            <li key={item} className="flex gap-2.5">
              <span
                aria-hidden
                className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                style={{ background: "var(--status-warning)" }}
              />
              <span className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                {item}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Before real patient data" />
        <ol className="mt-4 space-y-2">
          {[
            "Confirm Supabase Auth or replace it with the practice's identity provider",
            "Run the PostgreSQL access suite and complete the production security review",
            "Link every clinical account to a provider record and active care teams",
            "A paid database plan and a signed business associate agreement",
            "Encryption in transit and at rest, with audited access",
          ].map((step, index) => (
            <li key={step} className="flex gap-3">
              <span className="text-xs tabular-nums text-[var(--ink-muted)]">
                {index + 1}
              </span>
              <span className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                {step}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-[var(--ink-secondary)]">{label}</dt>
      <dd className="text-sm font-medium text-[var(--ink-primary)]">{value}</dd>
    </div>
  );
}
