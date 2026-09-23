import { Card, CardHeader, SegmentBar } from "@/components/charts";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import type { ProviderType } from "@/lib/domain/types";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { currentCapacity, simulateHiring } from "@/lib/scheduling/whatIf";

export const dynamic = "force-dynamic";

const PROVIDER_TYPES: ProviderType[] = [
  "RBT",
  "BCBA",
  "OT",
  "PT",
  "SLP",
  "LMHC",
  "LCSW",
  "PSYCHOLOGIST",
  "NEUROPSYCHOLOGIST",
];

/**
 * What-if and hiring simulation (spec sections 50 and 52).
 *
 * Everything here runs against a clone of the week held in memory. No
 * production data is touched — the spec requires that, and it is also what
 * makes the page safe to hand to someone mid-meeting.
 */
export default async function SimulatePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; type?: string; count?: string; service?: string }>;
}) {
  await requirePermission("analytics.whatif");
  const params = await searchParams;

  const { ctx } = await loadHorizon({ startDate: params.week ?? defaultWeekStart() });

  const services = [...ctx.services.values()]
    .filter((s) => s.active)
    .sort((a, b) => a.service_name.localeCompare(b.service_name));

  const serviceId =
    params.service ?? services.find((s) => s.service_code === "ABA_DIRECT")?.id ?? services[0].id;
  const providerType = (params.type ?? "RBT") as ProviderType;
  const count = Math.min(20, Math.max(1, Number(params.count ?? 3)));

  const baseline = currentCapacity(ctx);
  const result = simulateHiring(ctx, { providerType, count, serviceId });

  // A short ladder, so the shape of the return is visible rather than a single
  // number. Diminishing returns are the interesting part of this question.
  const ladder = [1, 2, 3, 5, 8]
    .filter((n) => n <= 12)
    .map((n) => ({
      count: n,
      gained: simulateHiring(ctx, { providerType, count: n, serviceId })
        .additional_schedulable_hours,
    }));

  // The first rung where hiring more stops adding anything, if there is one.
  const peak = Math.max(...ladder.map((step) => step.gained));
  const saturatesAt =
    peak > 0 ? (ladder.find((step) => step.gained >= peak - 0.001)?.count ?? null) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Simulation
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-[var(--ink-secondary)]">
          What would change if the practice hired. Runs against a copy of this
          week held in memory — nothing is written, and no schedule moves.
        </p>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4">
        <Field label="Hire">
          <input
            type="number"
            name="count"
            min={1}
            max={20}
            defaultValue={count}
            className={`${control} w-20`}
          />
        </Field>
        <Field label="Role">
          <select name="type" defaultValue={providerType} className={control}>
            {PROVIDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To deliver">
          <select name="service" defaultValue={serviceId} className={control}>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.service_name}
              </option>
            ))}
          </select>
        </Field>
        <input type="hidden" name="week" value={ctx.grid.startDate} />
        <button
          type="submit"
          className="rounded-full bg-[var(--brand)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Simulate
        </button>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Deliverable now</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {baseline.schedulable_hours}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            Hours patients could receive this week
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">After hiring</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {result.schedulable_hours_after}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          <p
            className="mt-3 text-xs"
            style={{
              color:
                result.additional_schedulable_hours > 0
                  ? "var(--status-good)"
                  : "var(--ink-muted)",
            }}
          >
            {result.additional_schedulable_hours > 0 ? "+" : ""}
            {result.additional_schedulable_hours}h from {count} × {providerType}
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">New hours used</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {result.added_clinical_hours > 0
              ? Math.round(
                  (result.additional_schedulable_hours / result.added_clinical_hours) * 100,
                )
              : 0}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">%</span>
          </div>
          <div className="mt-3">
            <SegmentBar
              value={result.additional_schedulable_hours}
              total={Math.max(result.added_clinical_hours, 1)}
              leftLabel="Usable"
              rightLabel="Wasted"
              leftValue={`${result.additional_schedulable_hours}h`}
              rightValue={`${result.wasted_hours}h`}
            />
          </div>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Still unstaffable</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {result.still_unfillable}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            Authorized, unscheduled, nobody free
          </p>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          {/*
            When every rung returns the same number the curve is flat, not
            diminishing — the first hire captured everything available. Saying
            "diminishing returns" over identical bars would misdescribe the
            result, so the heading follows the data.
          */}
          <CardHeader
            title={saturatesAt === 1 ? "Returns stop immediately" : "Diminishing returns"}
            sub={
              saturatesAt != null
                ? `Everything available is captured by hire ${saturatesAt}`
                : `Extra deliverable hours per ${providerType} hired`
            }
          />
          <div className="mt-4 space-y-2.5">
            {ladder.map((step) => {
              const max = Math.max(...ladder.map((s) => s.gained), 1);
              return (
                <div key={step.count} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                    {step.count} {step.count === 1 ? "hire" : "hires"}
                  </span>
                  <span className="flex h-5 min-w-0 flex-1 items-center">
                    <span
                      className="h-full rounded-md"
                      style={{
                        width: `${Math.max(2, (step.gained / max) * 100)}%`,
                        background: "var(--brand)",
                        opacity: 0.35 + 0.65 * (step.gained / max),
                      }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-[var(--ink-primary)]">
                    +{step.gained}h
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[var(--ink-secondary)]">
            {saturatesAt === 1 ? (
              <>
                One {providerType} absorbs all of it. Every further hire adds
                roster hours and no care, because the limit here is when
                patients are free and what their authorizations allow — not how
                many clinicians the practice employs.
              </>
            ) : (
              <>
                Extra clinicians stop helping once demand, patient availability
                or authorization runs out — usually well before the roster does.
              </>
            )}
          </p>
        </Card>

        <Card>
          <CardHeader title="What the simulation found" />
          <ul className="mt-4 space-y-3">
            {result.notes.map((note) => (
              <li key={note} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                  style={{ background: "var(--brand)" }}
                />
                <span className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                  {note}
                </span>
              </li>
            ))}
            <li className="flex gap-2.5">
              <span
                aria-hidden
                className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                style={{ background: "var(--brand)" }}
              />
              <span className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                {result.patients_helped}{" "}
                {result.patients_helped === 1 ? "patient" : "patients"} would be
                able to receive more care.
              </span>
            </li>
          </ul>
        </Card>
      </div>

      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        The figure that matters is deliverable hours, not roster hours. Adding
        clinicians whose free time does not line up with when patients are
        available buys nothing, which is why this page reports both.
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
