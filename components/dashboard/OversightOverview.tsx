import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { IconArrowUpRight } from "@/components/shell/icons";

/**
 * The dashboard for a role that oversees the system without working inside it.
 *
 * The clinical dashboard was being served to every signed-in role, including
 * the compliance officer — whose single permission is `audit.read`. That put
 * patient demographics, service mix and a named clinician's week in front of
 * someone with no clinical reason to see any of it. Least privilege has to
 * hold on the landing screen too, not only on the pages behind a permission
 * check.
 *
 * Everything here is a count. Nothing identifies a patient or a clinician.
 */
export function OversightOverview({
  roleLabel,
  weekStart,
  appointments,
  services,
  locations,
  overrides,
  auditEntries,
}: {
  roleLabel: string;
  weekStart: string;
  appointments: number;
  services: number;
  locations: number;
  overrides: number;
  auditEntries: number;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Oversight
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-[var(--ink-secondary)]">
          {roleLabel} · week of {weekStart}. Figures only — this role reads the
          audit trail, so nothing on this screen names a patient or a clinician.
        </p>
      </div>

      <dl className="grid gap-px overflow-hidden rounded-2xl border border-[var(--border-ring)] bg-[var(--rule-hairline)] sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Appointments this week",
            value: String(appointments),
            hint: "Across the practice",
          },
          { label: "Services configured", value: String(services) },
          { label: "Locations", value: String(locations) },
          {
            label: "Constraint overrides",
            value: String(overrides),
            hint: "Each one needs a recorded reason",
          },
        ].map((stat) => (
          <div key={stat.label} className="bg-[var(--surface-1)] px-5 py-5">
            <dt className="text-xs text-[var(--ink-secondary)]">{stat.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-[var(--ink-primary)]">
              {stat.value}
            </dd>
            {stat.hint && (
              <dd className="mt-1 text-[0.6875rem] text-[var(--ink-muted)]">{stat.hint}</dd>
            )}
          </div>
        ))}
      </dl>

      <Card>
        <CardHeader
          title="Audit trail"
          sub={
            auditEntries === 0
              ? "No entries yet — nothing in this build writes"
              : `${auditEntries} entries`
          }
        />
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
          Every schedule change will record who made it, what it replaced, and
          the reason given for any override. Phase 1 makes no changes, so the
          table is genuinely empty rather than seeded with examples.
        </p>
        <Link
          href="/audit"
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Open the audit log
          <IconArrowUpRight className="size-3.5" />
        </Link>
      </Card>

      <Card>
        <CardHeader title="What this role cannot reach" />
        <ul className="mt-3 space-y-2">
          {[
            "Patient records, demographics and clinical requirements",
            "Clinician schedules, caseloads and credentials",
            "Booking, approving or optimizing anything",
            "Authorizations and the hours they fund",
          ].map((item) => (
            <li
              key={item}
              className="flex gap-2.5 text-xs leading-relaxed text-[var(--ink-secondary)]"
            >
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-full"
                style={{ background: "var(--ink-muted)" }}
              />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-[var(--ink-muted)]">
          Read-only oversight is only meaningful if it is genuinely read-only.
          When this reaches a database, the same boundary is enforced again in
          Postgres row-level security rather than in the page.
        </p>
      </Card>
    </div>
  );
}
