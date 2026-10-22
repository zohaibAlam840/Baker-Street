import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { can } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function ProviderAvailabilityPage({ params, searchParams }: {
  params: Promise<{ providerId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const [session, { providerId }, query] = await Promise.all([
    requireSession(),
    params,
    searchParams,
  ]);
  const canManage = can(session.role, "availability.manage");
  const canRequestOwn = can(session.role, "availability.request")
    && session.providerId === providerId;
  if (!canManage && !canRequestOwn) {
    redirect("/no-access?permission=availability.request");
  }

  const { ctx } = await loadHorizon({ startDate: query.week ?? defaultWeekStart() });
  const provider = ctx.providers.get(providerId);
  if (!provider) notFound();
  const rows = ctx.rows.providerAvailability.filter((row) => row.provider_id === providerId);

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/providers/${providerId}?week=${ctx.grid.startDate}`} className="text-xs text-[var(--ink-secondary)] underline underline-offset-4">← Clinician record</Link>
        <h1 className="mt-2 text-xl font-semibold text-[var(--ink-primary)]">{provider.first_name} {provider.last_name} · availability</h1>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">Recurring clinical hours are shown below. Planned absences require review; urgent callouts take effect immediately.</p>
      </div>

      <Card>
        <CardHeader title="Recurring weekly hours" sub="Read-only availability pattern" />
        <div className="mt-4 space-y-3">
          {rows.map((row) => (
            <div key={row.id} className="grid gap-2 rounded-lg border border-[var(--rule-hairline)] p-3 sm:grid-cols-[1fr_1fr_1fr_1fr]">
              <span className="text-sm font-medium">{days[row.day_of_week]}</span>
              <span className="text-sm text-[var(--ink-secondary)]">{row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)}</span>
              <span className="text-sm text-[var(--ink-secondary)]">{row.availability_type}</span>
              <span className="text-sm text-[var(--ink-secondary)]">{row.location_id ? ctx.locations.get(row.location_id)?.name : "Any location"}</span>
            </div>
          ))}
          {!rows.length && (
            <p className="rounded-xl bg-[var(--surface-sunken)] p-4 text-sm text-[var(--ink-secondary)]">No recurring availability has been recorded for this clinician.</p>
          )}
        </div>
      </Card>

      {canRequestOwn && (
        <Card>
          <CardHeader
            title="Need planned time off?"
            sub="Submit exact dates and times for scheduler review"
          />
          <p className="mt-4 text-sm leading-6 text-[var(--ink-secondary)]">
            A request does not change the live schedule. Once approved, affected visits move safely into schedule recovery.
          </p>
          <Link
            href="/time-off"
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[var(--brand)] px-5 text-center text-sm font-medium text-white sm:w-auto"
          >
            Request time off
          </Link>
        </Card>
      )}

      <Card>
        <CardHeader
          title={canRequestOwn && !canManage ? "Illness or emergency?" : "Manage an urgent callout"}
          sub="Immediate callouts safely handle affected visits and replacement work"
        />
        <p className="mt-4 text-sm leading-6 text-[var(--ink-secondary)]">
          {canRequestOwn && !canManage
            ? "Report an urgent absence with its exact dates and times. This takes effect immediately and sends affected visits to scheduling staff."
            : "Open schedule recovery to record an absence for this or another clinician and move affected visits into the recovery queue."}
        </p>
        <Link
          href="/recovery"
          className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[var(--brand)] px-5 text-center text-sm font-medium text-white sm:w-auto"
        >
          {canRequestOwn && !canManage ? "Report my callout" : "Open schedule recovery"}
        </Link>
      </Card>
    </div>
  );
}
