import Link from "next/link";

import { StatTile } from "@/components/schedule/StatTile";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { formatClockTime } from "@/lib/domain/time";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { analyseFillService } from "@/lib/scheduling/fillService";
import { FlatTravelModel } from "@/lib/rules/travel";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function OptimizePage({
  searchParams,
}: {
  searchParams: Promise<{
    week?: string;
    patient?: string;
    service?: string;
    target?: string;
  }>;
}) {
  await requirePermission("schedule.optimize");
  const params = await searchParams;

  const { ctx, synthetic } = await loadHorizon({
    startDate: params.week ?? defaultWeekStart(),
  });

  const patients = [...ctx.patients.values()].sort((a, b) =>
    a.last_name.localeCompare(b.last_name),
  );
  const patientId = params.patient ?? patients[0]?.id;
  const patient = patientId ? ctx.patients.get(patientId) : undefined;

  // Services this patient actually has a requirement or authorization for.
  const serviceIds = new Set([
    ...(ctx.patientServiceRequirements.get(patientId ?? "") ?? []).map((r) => r.service_id),
    ...(ctx.authorizations.get(patientId ?? "") ?? []).map((a) => a.service_id),
  ]);
  const services = [...serviceIds]
    .map((id) => ctx.services.get(id))
    .filter((s) => s != null)
    .sort((a, b) => a.service_name.localeCompare(b.service_name));

  const serviceId = params.service ?? services[0]?.id;
  const requirement =
    patientId && serviceId ? ctx.requirementFor(patientId, serviceId) : null;
  const targetHours = params.target
    ? Number(params.target)
    : (requirement?.target_hours_per_week ?? undefined);

  const analysis =
    patient && serviceId
      ? analyseFillService(ctx, {
          patient_id: patient.id,
          service_id: serviceId,
          target_hours: targetHours,
          travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
        })
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">Fill service</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--ink-secondary)]">
          How close can this patient get to their target hours this week, and
          what is stopping them. Works for any service — ABA is simply the one
          with the most demanding target.
        </p>
      </div>

      {/* One filter row above everything it scopes. */}
      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4">
        <Field label="Patient">
          <select name="patient" defaultValue={patientId} className={selectClass}>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.first_name} {p.last_name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Service">
          <select name="service" defaultValue={serviceId} className={selectClass}>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.service_name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Target hours">
          <input
            type="number"
            name="target"
            min={0}
            step={0.25}
            defaultValue={targetHours ?? ""}
            className={`${selectClass} w-28`}
          />
        </Field>

        <input type="hidden" name="week" value={ctx.grid.startDate} />

        <button
          type="submit"
          className="rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Analyse
        </button>
      </form>

      {analysis && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Scheduled now"
              value={analysis.current_hours}
              unit="hours"
              meter={
                analysis.target_hours
                  ? { value: analysis.current_hours, max: analysis.target_hours }
                  : undefined
              }
              detail={analysis.target_hours ? `Target ${analysis.target_hours}h` : undefined}
            />
            <StatTile
              label="Reachable this week"
              value={analysis.projected_hours}
              unit="hours"
              tone={
                analysis.target_hours && analysis.projected_hours >= analysis.target_hours
                  ? "good"
                  : "warning"
              }
              detail={
                analysis.achievable_additional_hours > 0
                  ? `+${analysis.achievable_additional_hours}h from ${analysis.proposed.length} appointment(s)`
                  : "No additional hours available"
              }
            />
            <StatTile
              label="Authorization left"
              value={analysis.remaining_authorization ?? "—"}
              unit={analysis.remaining_authorization != null ? "hours" : undefined}
              detail={
                analysis.authorized_hours != null
                  ? `${analysis.authorized_hours}h authorized in total`
                  : "This service needs no authorization"
              }
            />
            <StatTile
              label="Confidence"
              value={analysis.exact ? "Exact" : "Bounded"}
              tone={analysis.exact ? "good" : "warning"}
              detail={
                analysis.exact
                  ? "No arrangement can do better"
                  : `Up to ${analysis.upper_bound_additional_hours}h might fit with a solver`
              }
            />
          </div>

          {/* Being explicit that this is analysis, not optimisation. */}
          <p className="text-xs text-[var(--ink-secondary)]">
            {analysis.exact
              ? "Greedy placement matched the theoretical maximum, so this is provably the best available answer."
              : "Greedy placement found less than the theoretical maximum. A solver may find a better arrangement; the gap is listed below."}
          </p>

          {analysis.proposed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-[var(--ink-primary)]">
                Proposed appointments
              </h2>
              <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
                <table className="w-full min-w-[34rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[var(--rule-hairline)]">
                      <th className={thClass}>When</th>
                      <th className={thClass}>Length</th>
                      <th className={thClass}>Provider</th>
                      <th className={thClass}>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.proposed.map((candidate) => {
                      const dayIndex = Math.floor(candidate.start_slot / 96);
                      const startMinutes = (candidate.start_slot % 96) * SLOT_MINUTES;
                      const endMinutes = (candidate.end_slot % 96 || 96) * SLOT_MINUTES;
                      const provider = ctx.providers.get(candidate.provider_id);
                      return (
                        <tr
                          key={candidate.candidate_id}
                          className="border-b border-[var(--rule-hairline)] last:border-0"
                        >
                          <td className={`${tdClass} tabular-nums`}>
                            {WEEKDAYS[ctx.grid.weekdayOf(dayIndex)]}{" "}
                            {formatClockTime(startMinutes)}–{formatClockTime(endMinutes)}
                          </td>
                          <td className={`${tdClass} tabular-nums`}>
                            {slotsToHours(candidate.duration_slots)}h
                          </td>
                          <td className={tdClass}>
                            {provider
                              ? `${provider.first_name} ${provider.last_name}`
                              : "—"}
                          </td>
                          <td className={`${tdClass} text-[var(--ink-secondary)]`}>
                            {candidate.location_id
                              ? (ctx.locations.get(candidate.location_id)?.name ?? "—")
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--ink-secondary)]">
                Nothing is booked. Phase 1 is read-only — approving and
                committing changes is built alongside the solver.
              </p>
            </section>
          )}

          {analysis.limiting_factors.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-[var(--ink-primary)]">
                Why the target is out of reach
              </h2>
              <ol className="space-y-2">
                {analysis.limiting_factors.map((factor, index) => (
                  <li
                    key={factor.code}
                    className="flex items-start gap-3 rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3"
                  >
                    <span className="mt-0.5 text-xs tabular-nums text-[var(--ink-muted)]">
                      {index + 1}
                    </span>
                    <span className="text-sm text-[var(--ink-primary)]">
                      {factor.message}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="text-xs text-[var(--ink-secondary)]">
                Listed most limiting first — the top item is the binding
                constraint.
              </p>
            </section>
          )}

          <p className="text-xs text-[var(--ink-muted)]">
            {analysis.meta.candidates_considered} candidate appointments
            considered in {analysis.meta.runtime_ms}ms
            {synthetic && " · synthetic data"} ·{" "}
            <Link
              href={`/patients/${analysis.patient_id}?week=${ctx.grid.startDate}`}
              className="underline underline-offset-4"
            >
              see this week
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

const selectClass =
  "rounded-md border border-[var(--border-ring)] bg-[var(--surface-1)] px-2.5 py-1.5 text-sm text-[var(--ink-primary)]";
const thClass =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]";
const tdClass = "px-3 py-2 text-left align-top";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--ink-secondary)]">{label}</span>
      {children}
    </label>
  );
}
