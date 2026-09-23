import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { requirePermission } from "@/lib/auth/session";
import { EXAMPLE_REQUESTS, interpret } from "@/lib/ai/interpret";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { formatClockTime } from "@/lib/domain/time";
import { FlatTravelModel } from "@/lib/rules/travel";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { analyseFillService } from "@/lib/scheduling/fillService";
import { currentCapacity, simulateHiring } from "@/lib/scheduling/whatIf";
import type { ProviderType } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The assistant (spec sections 58-59).
 *
 * Every answer on this page is computed by the scheduling engine. The language
 * layer only decides *which question was asked*; it never decides the answer,
 * never invents availability, and cannot book anything. The parsed request is
 * shown on screen precisely so that boundary is visible rather than claimed.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; week?: string }>;
}) {
  await requirePermission("schedule.search_availability");
  const { q, week } = await searchParams;

  const { ctx } = await loadHorizon({ startDate: week ?? defaultWeekStart() });
  const travel = new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true });

  const request = q ? interpret(q, ctx) : null;

  // The engine answers. The parser only chose which question to ask it.
  let answer: React.ReactNode = null;

  if (request && request.intent === "CHECK_CAPACITY") {
    const capacity = currentCapacity(ctx);
    answer = (
      <Card>
        <CardHeader title="Capacity right now" />
        <dl className="mt-4 space-y-2.5">
          <Row label="Deliverable hours this week" value={`${capacity.schedulable_hours}h`} />
          <Row label="Unused authorization" value={`${capacity.unused_authorization}h`} />
          <Row label="Of which unstaffable" value={`${capacity.unfillable}h`} />
          <Row label="Patients with headroom" value={String(capacity.patients_with_headroom)} />
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-[var(--ink-secondary)]">
          Unused authorization is not the same as available capacity:{" "}
          {capacity.unfillable}h are funded but have nobody free to deliver them.
        </p>
      </Card>
    );
  } else if (request && request.intent === "WHAT_IF_HIRE") {
    const aba = [...ctx.services.values()].find((s) => s.service_code === "ABA_DIRECT");
    const result = simulateHiring(ctx, {
      providerType: (request.provider_type ?? "RBT") as ProviderType,
      count: request.count ?? 1,
      serviceId: aba?.id ?? [...ctx.services.values()][0].id,
    });
    answer = (
      <Card>
        <CardHeader title={result.label} sub="Simulated — nothing was changed" />
        <dl className="mt-4 space-y-2.5">
          <Row
            label="Extra hours patients could receive"
            value={`${result.additional_schedulable_hours}h`}
          />
          <Row label="Clinical hours added" value={`${result.added_clinical_hours}h`} />
          <Row label="Of which unusable" value={`${result.wasted_hours}h`} />
          <Row label="Patients helped" value={String(result.patients_helped)} />
        </dl>
        <ul className="mt-4 space-y-1.5">
          {result.notes.map((note) => (
            <li key={note} className="text-xs leading-relaxed text-[var(--ink-secondary)]">
              {note}
            </li>
          ))}
        </ul>
      </Card>
    );
  } else if (
    request &&
    (request.intent === "FILL_SERVICE" ||
      request.intent === "OPTIMIZE_PATIENT" ||
      request.intent === "EXPLAIN_PATIENT") &&
    request.patient_id &&
    request.service_id
  ) {
    const analysis = analyseFillService(ctx, {
      patient_id: request.patient_id,
      service_id: request.service_id,
      target_hours: request.target_hours,
      travel,
    });

    answer = (
      <Card>
        <CardHeader
          title={`${request.patient_name}: ${analysis.service_name}`}
          sub={
            analysis.target_hours
              ? `${analysis.current_hours}h scheduled, target ${analysis.target_hours}h`
              : `${analysis.current_hours}h scheduled`
          }
        />

        <p className="mt-4 text-sm leading-relaxed text-[var(--ink-primary)]">
          {analysis.achievable_additional_hours > 0 ? (
            <>
              {request.patient_name?.split(" ")[0]} can reach{" "}
              <strong>{analysis.projected_hours} hours</strong> this week — an
              extra {analysis.achievable_additional_hours}h across{" "}
              {analysis.proposed.length}{" "}
              {analysis.proposed.length === 1 ? "appointment" : "appointments"}.
              {analysis.exact
                ? " No arrangement can do better."
                : ` A better arrangement may exist, up to ${analysis.upper_bound_additional_hours}h.`}
            </>
          ) : (
            <>
              No additional {analysis.service_name} hours can be added this week.
            </>
          )}
        </p>

        {analysis.proposed.length > 0 && (
          <ul className="mt-4 space-y-2">
            {analysis.proposed.map((candidate) => {
              const day = Math.floor(candidate.start_slot / SLOTS_PER_DAY);
              const startMinutes = (candidate.start_slot % SLOTS_PER_DAY) * SLOT_MINUTES;
              const provider = ctx.providers.get(candidate.provider_id);
              return (
                <li
                  key={candidate.candidate_id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface-sunken)] px-3 py-2"
                >
                  <span className="text-sm tabular-nums text-[var(--ink-primary)]">
                    {WEEKDAYS[ctx.grid.weekdayOf(day)]} {formatClockTime(startMinutes)}
                  </span>
                  <span className="text-xs text-[var(--ink-secondary)]">
                    {slotsToHours(candidate.duration_slots)}h ·{" "}
                    {provider ? `${provider.first_name} ${provider.last_name}` : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {analysis.limiting_factors.length > 0 && (
          <>
            <h3 className="mt-5 text-sm font-medium text-[var(--ink-primary)]">
              What is stopping it
            </h3>
            <ol className="mt-2 space-y-1.5">
              {analysis.limiting_factors.map((factor, index) => (
                <li
                  key={factor.code}
                  className="text-xs leading-relaxed text-[var(--ink-secondary)]"
                >
                  {index + 1}. {factor.message}
                </li>
              ))}
            </ol>
          </>
        )}

        <p className="mt-5 text-xs text-[var(--ink-muted)]">
          Computed by the scheduling engine in {analysis.meta.runtime_ms}ms across{" "}
          {analysis.meta.candidates_considered} candidate appointments. Nothing
          was booked.{" "}
          <Link
            href={`/schedule/patient/${request.patient_id}?week=${ctx.grid.startDate}`}
            className="underline underline-offset-4"
          >
            See the week
          </Link>
        </p>
      </Card>
    );
  } else if (request) {
    answer = (
      <Card>
        <CardHeader title="I could not turn that into a scheduling request" />
        <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
          {request.unmatched.length > 0
            ? `Missing: ${request.unmatched.join(", ")}.`
            : "No recognised intent."}{" "}
          Try one of the examples below — this parser handles a fixed set of
          phrasings, not open language.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Assistant
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-[var(--ink-secondary)]">
          Ask in plain English. The assistant turns your sentence into a
          scheduling request; the engine works out the answer.
        </p>
      </div>

      <form className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <input
          type="text"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Get John to 30 hours of ABA without moving his OT"
          className="h-11 min-w-0 flex-1 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-4 text-sm outline-none placeholder:text-[var(--ink-muted)] focus:ring-2 focus:ring-[var(--brand-ring)]"
        />
        <input type="hidden" name="week" value={ctx.grid.startDate} />
        <button
          type="submit"
          className="h-11 shrink-0 rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
        >
          Ask
        </button>
      </form>

      {/* The boundary the spec draws, made visible. */}
      {request && (
        <Card>
          <CardHeader
            title="Understood as"
            sub={
              request.confidence === "high"
                ? "Parsed with confidence"
                : "Low confidence — check this is what you meant"
            }
          />
          <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--surface-sunken)] p-3 text-xs leading-relaxed text-[var(--ink-secondary)]">
{JSON.stringify(
  {
    intent: request.intent,
    patient: request.patient_name ?? null,
    service: request.service_name ?? null,
    target_hours: request.target_hours ?? null,
    protected_services:
      request.protected_services?.map((id) => ctx.services.get(id)?.service_name) ?? null,
    provider_type: request.provider_type ?? null,
    count: request.count ?? null,
  },
  null,
  2,
)}
          </pre>
          <p className="mt-3 text-xs leading-relaxed text-[var(--ink-secondary)]">
            This is the whole of the assistant&rsquo;s job. It cannot invent
            availability, decide whether a schedule is legal, book anything, or
            override an authorization — the engine does all of that, and the
            answer below is the engine&rsquo;s.
          </p>
        </Card>
      )}

      {answer}

      <Card>
        <CardHeader title="Try" />
        <ul className="mt-3 flex flex-wrap gap-2">
          {EXAMPLE_REQUESTS.map((example) => (
            <li key={example}>
              <Link
                href={`/assistant?q=${encodeURIComponent(example)}&week=${ctx.grid.startDate}`}
                className="inline-block rounded-full border border-[var(--border-ring)] px-3 py-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-sunken)]"
              >
                {example}
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        No language model is connected. This is a deterministic parser over a
        fixed set of phrasings, present to demonstrate the architecture the
        specification requires: language in, structured request out, engine
        decides. Replacing the parser with a model changes this one file.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-[var(--ink-secondary)]">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
        {value}
      </dd>
    </div>
  );
}
