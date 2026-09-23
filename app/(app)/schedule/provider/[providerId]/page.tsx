import Link from "next/link";
import { notFound } from "next/navigation";

import { Legend } from "@/components/schedule/Legend";
import { StatTile } from "@/components/schedule/StatTile";
import { WeekGrid } from "@/components/schedule/WeekGrid";
import { WeekNav } from "@/components/schedule/WeekNav";
import { AppointmentTable } from "@/components/schedule/tables";
import { loadHorizon } from "@/lib/data/snapshot";
import { requirePermission } from "@/lib/auth/session";
import { slotsToHours } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { buildWeekView } from "@/lib/scheduling/weekView";

export const dynamic = "force-dynamic";

export default async function ProviderWeekPage({
  params,
  searchParams,
}: {
  params: Promise<{ providerId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  await requirePermission("view.provider_schedule");
  const { providerId } = await params;
  const { week } = await searchParams;

  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const provider = ctx.providers.get(providerId);
  if (!provider) notFound();

  const view = buildWeekView(ctx, { subject: { kind: "provider", id: providerId } });

  // Capacity: clinical hours available, against clinical hours booked. The gap
  // is what spec section 51 means by capacity — distinct from unused
  // authorization, which may not be fillable at all.
  const availableHours = ctx
    .providerClinicalWindows(providerId)
    .reduce((total, window) => total + slotsToHours(window.endSlot - window.startSlot), 0);
  const bookedHours = (ctx.appointmentsByProvider.get(providerId) ?? []).reduce(
    (total, a) => total + slotsToHours(a.range.endSlot - a.range.startSlot),
    0,
  );
  const utilization =
    availableHours > 0 ? Math.round((bookedHours / availableHours) * 100) : 0;

  const services = [...(ctx.providerServices.get(providerId)?.values() ?? [])]
    .filter((link) => link.eligible)
    .map((link) => ctx.services.get(link.service_id)?.service_name)
    .filter((name): name is string => Boolean(name));

  const departments = [
    ...new Map(
      view.blocks.map((block) => [
        block.department,
        { name: block.department, slot: block.departmentSlot },
      ]),
    ).values(),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--ink-primary)]">
            {provider.first_name} {provider.last_name}
          </h1>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            {provider.provider_type}
            {provider.status !== "ACTIVE" && ` · ${provider.status.toLowerCase()}`}
            {services.length > 0 && ` · ${services.join(", ")}`}
          </p>
        </div>
        <Link
          href={`/schedule?week=${view.startDate}`}
          className="text-sm text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--ink-primary)]"
        >
          All schedules
        </Link>
      </div>

      <WeekNav
        basePath={`/schedule/provider/${providerId}`}
        weekStart={view.startDate}
        synthetic={synthetic}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Booked"
          value={bookedHours}
          unit="hours"
          meter={{ value: bookedHours, max: Math.max(availableHours, 1) }}
          detail={`of ${availableHours}h clinical availability`}
        />
        <StatTile
          label="Utilization"
          value={`${utilization}%`}
          tone={utilization >= 80 ? "good" : "warning"}
          detail={utilization >= 80 ? "At or near capacity" : "Open capacity remains"}
        />
        <StatTile
          label="Open capacity"
          value={Math.max(0, Math.round((availableHours - bookedHours) * 100) / 100)}
          unit="hours"
          detail="Unbooked clinical time this week"
        />
        <StatTile
          label="Patients"
          value={new Set(view.blocks.map((b) => b.counterpart)).size}
          detail={`${view.blocks.length} appointments`}
        />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-[var(--ink-primary)]">Week</h2>
          <Legend departments={departments} />
        </div>
        <div className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-page)] p-2">
          <WeekGrid view={view} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">Appointments</h2>
        <AppointmentTable view={view} />
      </section>
    </div>
  );
}
