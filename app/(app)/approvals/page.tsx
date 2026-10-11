import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ApprovalForm } from "@/components/optimizer/ApprovalForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { addDays, formatClockTime } from "@/lib/domain/time";
import { FlatTravelModel } from "@/lib/rules/travel";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { optimizePatientWeek } from "@/lib/scheduling/optimizer";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    week?: string;
    patient?: string;
    error?: string;
    notice?: string;
  }>;
}) {
  await requirePermission("schedule.optimize");
  const params = await searchParams;
  let { ctx } = await loadHorizon({
    startDate: params.week ?? defaultWeekStart(),
    includeOpaqueBusy: true,
  });
  const patients = [...ctx.patients.values()]
    .filter((patient) => patient.status === "ACTIVE")
    .sort((a, b) => a.last_name.localeCompare(b.last_name));
  let patient = params.patient
    ? patients.find((row) => row.id === params.patient) ?? null
    : patients[0] ?? null;
  const patientId = patient?.id;
  if (patient?.timezone && patient.timezone !== ctx.grid.timeZone) {
    ({ ctx } = await loadHorizon({
      startDate: params.week ?? defaultWeekStart(),
      timeZone: patient.timezone,
      includeOpaqueBusy: true,
    }));
    patient = ctx.patients.get(patient.id) ?? null;
  }
  const weekLabel = `${ctx.grid.startDate} to ${addDays(ctx.grid.startDate, 6)}`;
  const optimization = patientId
    ? optimizePatientWeek(ctx, {
        patient_id: patientId,
        max_solutions: 5,
        start_step_slots: 1,
        travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
      })
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">
            Multi-service optimizer
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
            Compare complete plans
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--ink-secondary)]">
            Required care is protected first. The engine then balances target hours,
            continuity, visit count, preferences, authorization, staff, rooms, and travel.
          </p>
          <p className="mt-2 text-xs font-medium text-[var(--ink-muted)]">
            Week {weekLabel} Â· {ctx.grid.timeZone}
          </p>
        </div>
        <Link
          href={`/schedule?week=${ctx.grid.startDate}`}
          className="min-h-11 rounded-full border border-[var(--border-ring)] px-4 py-3 text-sm text-[var(--ink-primary)]"
        >
          View current week
        </Link>
      </div>

      {params.error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {params.error}
        </p>
      )}
      {params.notice && (
        <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-4 text-sm text-[var(--ink-primary)]">
          {params.notice}
        </p>
      )}

      <form className="card grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--ink-secondary)]">Patient</span>
          <select
            name="patient"
            defaultValue={patientId}
            className="min-h-11 rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 text-sm text-[var(--ink-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-ring)]"
          >
            {patients.map((row) => (
              <option key={row.id} value={row.id}>
                {row.first_name} {row.last_name}
              </option>
            ))}
          </select>
        </label>
        <input type="hidden" name="week" value={ctx.grid.startDate} />
        <button className="min-h-11 rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white">
          Build plans
        </button>
      </form>

      {!optimization || !patient ? (
        <Card>
          <CardHeader title="No patient available" />
          <p className="mt-3 text-sm text-[var(--ink-secondary)]">
            Add an active patient and their clinical requirements before optimizing.
          </p>
        </Card>
      ) : (
        <>
          <section aria-labelledby="coverage-heading" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 id="coverage-heading" className="text-base font-semibold text-[var(--ink-primary)]">
                  {patient.first_name}&rsquo;s clinical coverage
                </h2>
                <p className="text-xs text-[var(--ink-secondary)]">
                  Current week compared with each configured target
                </p>
              </div>
              <Status status={optimization.status} />
            </div>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {optimization.goals.map((goal) => (
                <li key={goal.service_id} className="card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-[var(--ink-primary)]">
                      {goal.service_name}
                    </span>
                    {goal.required && (
                      <span className="rounded-full bg-[var(--brand-tint)] px-2 py-1 text-[0.625rem] font-medium text-[var(--brand)]">
                        Required
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-xl font-semibold tabular-nums text-[var(--ink-primary)]">
                    {goal.current_hours}h
                    <span className="ml-1 text-xs font-normal text-[var(--ink-muted)]">
                      / {goal.target_hours}h target
                    </span>
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                    <div
                      className="h-full rounded-full bg-[var(--brand)]"
                      style={{ width: `${Math.min(100, goal.target_hours ? goal.current_hours / goal.target_hours * 100 : 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {optimization.plans.length === 0 && optimization.status === "TARGETS_MET" ? (
            <Card>
              <CardHeader title="No changes needed" />
              <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
                The current schedule already meets every configured target for this week.
              </p>
            </Card>
          ) : optimization.plans.length === 0 ? (
            <Card>
              <CardHeader title="No safe complete plan was found" />
              <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
                The optimizer made no changes. Review the limiting facts below; authorization,
                availability, credentials, or capacity may need attention before another attempt.
              </p>
            </Card>
          ) : (
            <ol className="grid gap-4 xl:grid-cols-2">
              {optimization.plans.map((plan, index) => (
                <li key={plan.id}>
                  <Card className={index === 0 ? "h-full ring-2 ring-[var(--brand-ring)]" : "h-full"}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--brand)]">
                          Option {index + 1}{index === 0 ? " · Recommended" : ""}
                        </p>
                        <h2 className="mt-1 text-base font-semibold text-[var(--ink-primary)]">
                          {plan.label}
                        </h2>
                        <p className="mt-1 text-xs leading-relaxed text-[var(--ink-secondary)]">
                          {plan.rationale}
                        </p>
                      </div>
                      <span className="shrink-0 text-right">
                        <span className="block text-2xl font-semibold tabular-nums text-[var(--ink-primary)]">
                          +{plan.added_hours}h
                        </span>
                        <span className="text-[0.625rem] text-[var(--ink-muted)]">
                          {plan.appointments.length} new visits
                        </span>
                      </span>
                    </div>

                    <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-[var(--surface-sunken)] p-3 text-center">
                      <Metric label="Targets" value={`${plan.targets_met}/${plan.service_metrics.length}`} />
                      <Metric label="New staff" value={String(plan.provider_changes)} />
                      <Metric label="Preferred" value={String(plan.preferred_appointments)} />
                    </dl>

                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                      {plan.service_metrics.map((metric) => (
                        <li
                          key={metric.service_id}
                          className="rounded-lg border border-[var(--rule-hairline)] p-2.5 text-xs"
                        >
                          <span className="block font-medium text-[var(--ink-primary)]">
                            {metric.service_name}
                          </span>
                          <span className="mt-0.5 block tabular-nums text-[var(--ink-secondary)]">
                            {metric.current_hours}h current â†’ {metric.projected_hours}h projected Â· {metric.target_hours}h target
                          </span>
                        </li>
                      ))}
                    </ul>

                    {!plan.approvable && (
                      <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
                        Diagnostic only: this plan does not preserve every required clinical minimum.
                      </p>
                    )}

                    <ul className="mt-4 divide-y divide-[var(--rule-hairline)]">
                      {plan.appointments.map((appointment) => {
                        const day = Math.floor(appointment.start_slot / SLOTS_PER_DAY);
                        const provider = ctx.providers.get(appointment.provider_id);
                        const service = ctx.services.get(appointment.service_id);
                        const location = appointment.location_id
                          ? ctx.locations.get(appointment.location_id)
                          : null;
                        return (
                          <li key={appointment.candidate_id} className="grid grid-cols-[auto_1fr] gap-3 py-3">
                            <span className="w-16 text-xs font-medium tabular-nums text-[var(--ink-primary)]">
                              {WEEKDAYS[ctx.grid.weekdayOf(day)]}
                              <span className="block text-[0.625rem] font-normal text-[var(--ink-muted)]">
                                {addDays(ctx.grid.startDate, day)}
                              </span>
                              <span className="block text-[0.625rem] font-normal text-[var(--ink-muted)]">
                                {formatClockTime((appointment.start_slot % SLOTS_PER_DAY) * SLOT_MINUTES)}
                              </span>
                              {appointment.resource_ids.length > 0 && (
                                <span className="mt-0.5 block text-[var(--ink-muted)]">
                                  {appointment.resource_ids
                                    .map((id) => ctx.resources.get(id)?.name ?? "Resource")
                                    .join(", ")}
                                </span>
                              )}
                            </span>
                            <span className="min-w-0 text-xs">
                              <span className="block font-medium text-[var(--ink-primary)]">
                                {service?.service_name ?? "Service"} · {slotsToHours(appointment.duration_slots)}h
                              </span>
                              <span className="mt-0.5 block text-[var(--ink-secondary)]">
                                {provider ? `${provider.first_name} ${provider.last_name}` : "Unassigned"}
                                {location ? ` · ${location.name}` : ""}
                              </span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    {plan.approvable && (
                      <ApprovalForm
                        patientId={patient.id}
                        week={ctx.grid.startDate}
                        planId={plan.id}
                        appointmentCount={plan.appointments.length}
                        addedHours={plan.added_hours}
                        optionLabel={`Option ${index + 1}: ${plan.label}`}
                        patientName={`${patient.first_name} ${patient.last_name}`}
                        weekLabel={weekLabel}
                      />
                    )}
                  </Card>
                </li>
              ))}
            </ol>
          )}

          {optimization.explanations.length > 0 && (
            <Card>
              <CardHeader title="What still limits care" sub="Facts from rejected openings and hard ceilings" />
              <ul className="mt-4 space-y-2">
                {optimization.explanations.map((item, index) => (
                  <li key={`${item.code}-${index}`} className="flex gap-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
                    <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                    {item.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
            {optimization.meta.searched_candidates.toLocaleString()} legal candidates searched in {optimization.meta.runtime_ms}ms.
            {optimization.status === "BOUNDED" && " The safety limit was reached, so this is the best plan found—not a claim that no better plan exists."}
            {" "}Approval reloads live data, recomputes the selected option, and commits all appointments in one database transaction.
          </p>
        </>
      )}
    </div>
  );
}

function Status({ status }: { status: "TARGETS_MET" | "FEASIBLE" | "INFEASIBLE" | "BOUNDED" }) {
  const labels = {
    TARGETS_MET: "Proposed plan reaches targets",
    FEASIBLE: "Best feasible plan",
    INFEASIBLE: "Needs attention",
    BOUNDED: "Best found",
  };
  return (
    <span className="rounded-full bg-[var(--surface-sunken)] px-3 py-1.5 text-xs font-medium text-[var(--ink-secondary)]">
      {labels[status]}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.625rem] text-[var(--ink-muted)]">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--ink-primary)]">{value}</dd>
    </div>
  );
}
