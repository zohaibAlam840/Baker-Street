import Link from "next/link";

import { StatTile } from "@/components/schedule/StatTile";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours, subtractRanges } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

/**
 * Organisation capacity (spec sections 51-54).
 *
 * The number this page exists to keep honest: unused authorization is NOT
 * available capacity. Hours can be authorized and still unschedulable because
 * nobody qualified is free. Both figures are shown, side by side, with the
 * difference named.
 */
export default async function CapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  await requirePermission("analytics.capacity");
  const { week } = await searchParams;
  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  // Authorization position across every patient and service.
  let authorizedHours = 0;
  let scheduledAgainstAuth = 0;
  for (const authorizations of ctx.authorizations.values()) {
    for (const authorization of authorizations) {
      if (authorization.status !== "ACTIVE" || authorization.authorized_hours == null) continue;
      authorizedHours += authorization.authorized_hours;
      scheduledAgainstAuth += slotsToHours(
        ctx.slotsUsedAgainstAuthorization(authorization.id),
      );
    }
  }
  const unusedAuthorization = Math.max(0, authorizedHours - scheduledAgainstAuth);

  // Provider capacity by type: clinical hours available, minus what is booked.
  const byType = new Map<
    string,
    { providers: number; available: number; booked: number }
  >();

  for (const provider of ctx.providers.values()) {
    if (provider.status !== "ACTIVE") continue;

    const windows = ctx.providerClinicalWindows(provider.id);
    const booked = (ctx.appointmentsByProvider.get(provider.id) ?? []).map((a) => a.range);
    const free = subtractRanges(windows, booked);

    const availableHours = windows.reduce(
      (total, w) => total + slotsToHours(w.endSlot - w.startSlot),
      0,
    );
    const bookedHours = booked.reduce(
      (total, r) => total + slotsToHours(r.endSlot - r.startSlot),
      0,
    );
    const freeHours = free.reduce(
      (total, w) => total + slotsToHours(w.endSlot - w.startSlot),
      0,
    );

    const bucket = byType.get(provider.provider_type) ?? {
      providers: 0,
      available: 0,
      booked: 0,
    };
    bucket.providers += 1;
    bucket.available += availableHours;
    bucket.booked += bookedHours;
    byType.set(provider.provider_type, bucket);

    void freeHours;
  }

  const rows = [...byType.entries()]
    .map(([type, v]) => ({
      type,
      ...v,
      open: Math.round((v.available - v.booked) * 100) / 100,
      utilization: v.available > 0 ? Math.round((v.booked / v.available) * 100) : 0,
    }))
    .sort((a, b) => b.available - a.available);

  const totalOpen = rows.reduce((total, r) => total + r.open, 0);

  // The distinction that matters: authorization you cannot staff.
  const unfillable = Math.max(0, unusedAuthorization - totalOpen);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">Capacity</h1>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">
          Week of {ctx.grid.startDate}
          {synthetic && " · synthetic data"}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Authorized"
          value={round(authorizedHours)}
          unit="hours"
          meter={{ value: scheduledAgainstAuth, max: Math.max(authorizedHours, 1) }}
          detail={`${round(scheduledAgainstAuth)}h scheduled against it`}
        />
        <StatTile
          label="Unused authorization"
          value={round(unusedAuthorization)}
          unit="hours"
          tone={unusedAuthorization > 0 ? "warning" : "good"}
          detail="Funded but not on anyone's calendar"
        />
        <StatTile
          label="Open clinical capacity"
          value={round(totalOpen)}
          unit="hours"
          detail="Clinician time free this week"
        />
        <StatTile
          label="Unfillable"
          value={round(unfillable)}
          unit="hours"
          tone={unfillable > 0 ? "warning" : "good"}
          detail={
            unfillable > 0
              ? "Authorized hours with no clinician free to deliver them"
              : "Every authorized hour could be staffed"
          }
        />
      </div>

      <div className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4">
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
          <span className="font-medium text-[var(--ink-primary)]">
            Unused authorization is not available capacity.
          </span>{" "}
          {round(unusedAuthorization)}h are funded and unscheduled, but only{" "}
          {round(totalOpen)}h of clinician time is free — and that free time has
          to line up with when patients are actually available. Treating the two
          as the same number is how organisations conclude they are losing
          revenue when what they are short of is staff.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Capacity by clinician type
        </h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--rule-hairline)]">
                <th className={thClass}>Type</th>
                <th className={`${thClass} text-right`}>People</th>
                <th className={`${thClass} text-right`}>Clinical hours</th>
                <th className={`${thClass} text-right`}>Booked</th>
                <th className={`${thClass} text-right`}>Open</th>
                <th className={`${thClass} text-right`}>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.type}
                  className="border-b border-[var(--rule-hairline)] last:border-0"
                >
                  <td className="px-3 py-2">{row.type}</td>
                  <td className={numClass}>{row.providers}</td>
                  <td className={numClass}>{round(row.available)}h</td>
                  <td className={numClass}>{round(row.booked)}h</td>
                  <td className={numClass}>{row.open}h</td>
                  <td className={numClass}>{row.utilization}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-[var(--ink-secondary)]">
        Hiring simulations — “what happens if we add three RBTs?” — need the
        what-if engine, which is built alongside the solver. See{" "}
        <Link href="/schedule" className="underline underline-offset-4">
          schedules
        </Link>{" "}
        for where the time actually sits.
      </p>
    </div>
  );
}

const thClass =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]";
const numClass = "px-3 py-2 text-right tabular-nums";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
