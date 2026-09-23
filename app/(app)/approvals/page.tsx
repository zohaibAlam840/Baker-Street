import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { formatClockTime } from "@/lib/domain/time";
import { FlatTravelModel } from "@/lib/rules/travel";
import { buildAlternatives } from "@/lib/scheduling/alternatives";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Ranked alternatives and the approval workflow (spec sections 56, 60-62).
 *
 * Section 8 is the whole point: a scheduler should be handed genuinely
 * different options — more hours against fewer changes — and pick, rather than
 * be given one answer and asked to trust it.
 *
 * Approving is disabled. The spec requires a locked, revalidated, atomic
 * commit with an audit entry (§63); a button that skipped any of that would be
 * worse than no button.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; patient?: string; service?: string; target?: string }>;
}) {
  const session = await requirePermission("schedule.optimize");
  const params = await searchParams;

  const { ctx } = await loadHorizon({ startDate: params.week ?? defaultWeekStart() });

  const patients = [...ctx.patients.values()]
    .filter((p) => p.status === "ACTIVE")
    .sort((a, b) => a.last_name.localeCompare(b.last_name));
  const patientId = params.patient ?? patients[0]?.id;
  const patient = patientId ? ctx.patients.get(patientId) : undefined;

  const serviceIds = new Set(
    (ctx.patientServiceRequirements.get(patientId ?? "") ?? []).map((r) => r.service_id),
  );
  const services = [...serviceIds]
    .map((id) => ctx.services.get(id))
    .filter((s) => s != null)
    .sort((a, b) => a.service_name.localeCompare(b.service_name));

  const serviceId = params.service ?? services[0]?.id;
  const requirement =
    patientId && serviceId ? ctx.requirementFor(patientId, serviceId) : null;
  const target = params.target
    ? Number(params.target)
    : (requirement?.target_hours_per_week ??
      ctx.authorizationsFor(patientId ?? "", serviceId ?? "")[0]?.authorized_hours ??
      0);

  const options =
    patientId && serviceId && target > 0
      ? buildAlternatives(ctx, {
          patient_id: patientId,
          service_id: serviceId,
          target_hours: target,
          travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
        })
      : [];

  const currentHours =
    patientId && serviceId ? slotsToHours(ctx.slotsScheduled(patientId, serviceId)) : 0;

  const mayApproveReduction = can(session.role, "schedule.approve_reduction");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Options
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-[var(--ink-secondary)]">
          Genuinely different ways to reach the target — more hours against
          fewer changes — rather than one answer to take on trust.
        </p>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4">
        <Field label="Patient">
          <select name="patient" defaultValue={patientId} className={control}>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.first_name} {p.last_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service">
          <select name="service" defaultValue={serviceId} className={control}>
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
            step={0.5}
            defaultValue={target}
            className={`${control} w-24`}
          />
        </Field>
        <input type="hidden" name="week" value={ctx.grid.startDate} />
        <button
          type="submit"
          className="rounded-full bg-[var(--brand)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Find options
        </button>
      </form>

      {options.length === 0 ? (
        <Card>
          <CardHeader title="No options to offer" />
          <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
            {patient?.first_name} is already at {currentHours}h, or nothing legal
            can be added this week.{" "}
            <Link href="/optimize" className="underline underline-offset-4">
              Fill service
            </Link>{" "}
            explains why.
          </p>
        </Card>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {options.map((option, index) => (
            <li key={option.strategy}>
              <Card className={index === 0 ? "ring-2 ring-[var(--brand-ring)]" : ""}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--ink-primary)]">
                      Option {index + 1} · {option.label}
                    </h2>
                    <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-secondary)]">
                      {option.rationale}
                    </p>
                  </div>
                  <span className="shrink-0 text-right">
                    <span className="block text-xl font-semibold tabular-nums text-[var(--ink-primary)]">
                      {option.projected_hours}h
                    </span>
                    <span className="block text-[0.625rem] text-[var(--ink-muted)]">
                      from {currentHours}h
                    </span>
                  </span>
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-[var(--surface-sunken)] p-3 text-center">
                  <div>
                    <dt className="text-[0.625rem] text-[var(--ink-muted)]">Added</dt>
                    <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                      +{option.added_hours}h
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[0.625rem] text-[var(--ink-muted)]">Visits</dt>
                    <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                      {option.appointments.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[0.625rem] text-[var(--ink-muted)]">New staff</dt>
                    <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                      {option.provider_changes}
                    </dd>
                  </div>
                </dl>

                <ul className="mt-3 space-y-1.5">
                  {option.appointments.map((candidate) => {
                    const day = Math.floor(candidate.start_slot / SLOTS_PER_DAY);
                    const startMinutes =
                      (candidate.start_slot % SLOTS_PER_DAY) * SLOT_MINUTES;
                    const provider = ctx.providers.get(candidate.provider_id);
                    return (
                      <li
                        key={candidate.candidate_id}
                        className="flex items-baseline justify-between gap-2 text-xs"
                      >
                        <span className="tabular-nums text-[var(--ink-primary)]">
                          {WEEKDAYS[ctx.grid.weekdayOf(day)]}{" "}
                          {formatClockTime(startMinutes)}
                        </span>
                        <span className="text-[var(--ink-secondary)]">
                          {slotsToHours(candidate.duration_slots)}h ·{" "}
                          {provider
                            ? `${provider.first_name} ${provider.last_name}`
                            : "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    disabled
                    title="Approving requires the transactional commit — built with real authentication"
                    className="flex-1 cursor-not-allowed rounded-full bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--ink-muted)]"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled
                    className="flex-1 cursor-not-allowed rounded-full border border-[var(--border-ring)] px-3 py-2 text-xs text-[var(--ink-muted)]"
                  >
                    Reject
                  </button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader title="What approving will do" />
        <ol className="mt-3 space-y-2">
          {[
            "Lock the affected appointments",
            "Re-prove every rule against the live data, not the data this page loaded",
            "Verify the authorization still has room",
            "Verify the clinician is still credentialled and free",
            "Apply the changes and write the audit entry — all in one transaction",
            "Roll the whole thing back if any step fails",
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
        <p className="mt-4 text-xs leading-relaxed text-[var(--ink-secondary)]">
          The buttons are disabled because none of that exists yet. Re-proving
          against live data matters: this page&rsquo;s options were computed from
          a snapshot, and someone else may have booked into the same slot since.
        </p>
      </Card>

      {!mayApproveReduction && (
        <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
          Your role can approve routine changes. A change that cuts a
          patient&rsquo;s hours below target, or drops a required service, needs
          a clinical supervisor.
        </p>
      )}

      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        These options come from named heuristics, each proved legal by the rule
        engine — not from a solver. Identical results are collapsed into one
        option, so nothing here differs only by reordering. A solver would
        search the space properly and could find combinations none of these
        strategies reach.
      </p>
    </div>
  );
}

const control =
  "h-10 rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 text-sm text-[var(--ink-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-ring)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--ink-secondary)]">{label}</span>
      {children}
    </label>
  );
}
