import Link from "next/link";
import { notFound } from "next/navigation";

import { Legend } from "@/components/schedule/Legend";
import { StatTile } from "@/components/schedule/StatTile";
import { WeekGrid } from "@/components/schedule/WeekGrid";
import { WeekNav } from "@/components/schedule/WeekNav";
import { AppointmentTable, ServiceSummaryTable } from "@/components/schedule/tables";
import { loadHorizon } from "@/lib/data/snapshot";
import { requirePermission } from "@/lib/auth/session";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { summarisePatientWeek } from "@/lib/scheduling/summary";
import { buildWeekView } from "@/lib/scheduling/weekView";

export const dynamic = "force-dynamic";

export default async function PatientWeekPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  await requirePermission("view.patient_schedule");
  const { patientId } = await params;
  const { week } = await searchParams;

  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const patient = ctx.patients.get(patientId);
  if (!patient) notFound();

  const view = buildWeekView(ctx, { subject: { kind: "patient", id: patientId } });
  const summary = summarisePatientWeek(ctx, patientId);

  // The service the week is actually about: the one with an hours target.
  // On this scenario that is ABA, but nothing here names it.
  const headline =
    summary.rows.find((row) => row.target_hours != null) ?? summary.rows[0] ?? null;

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
            {patient.first_name} {patient.last_name}
          </h1>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            Patient schedule
            {patient.external_id && ` · ${patient.external_id}`}
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
        basePath={`/schedule/patient/${patientId}`}
        weekStart={view.startDate}
        synthetic={synthetic}
      />

      {/* Stat tiles: the numbers a scheduler acts on, not charts of them. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {headline && (
          <>
            <StatTile
              label={`${headline.service_name} scheduled`}
              value={headline.scheduled_hours}
              unit="hours"
              meter={
                headline.target_hours != null
                  ? {
                      value: headline.scheduled_hours,
                      max: headline.target_hours,
                      slot: headline.departmentSlot,
                    }
                  : undefined
              }
              detail={
                headline.target_hours != null
                  ? `Target ${headline.target_hours}h`
                  : undefined
              }
            />
            <StatTile
              label="Authorized"
              value={headline.authorized_hours ?? "—"}
              unit={headline.authorized_hours != null ? "hours" : undefined}
              detail={
                headline.unused_authorization != null
                  ? `${headline.unused_authorization}h unused — not the same as available capacity`
                  : "No authorization on file"
              }
            />
          </>
        )}
        <StatTile
          label="Required services met"
          value={`${summary.required_services_met}/${summary.required_services_total}`}
          tone={
            summary.required_services_met === summary.required_services_total
              ? "good"
              : "warning"
          }
          detail={
            summary.required_services_met === summary.required_services_total
              ? "All clinical requirements satisfied"
              : "One or more requirements unmet"
          }
        />
        <StatTile
          label="Appointments"
          value={view.blocks.length}
          detail={`${new Set(view.blocks.map((b) => b.counterpart)).size} provider(s)`}
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
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Requirements and authorization
        </h2>
        <p className="max-w-3xl text-xs text-[var(--ink-secondary)]">
          Scheduled, clinical minimum, target and authorized are four separate
          numbers. Authorization is what the payer will pay for; it is never the
          same as what the patient clinically needs.
        </p>
        <ServiceSummaryTable rows={summary.rows} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Appointments
        </h2>
        <AppointmentTable view={view} />
      </section>
    </div>
  );
}
