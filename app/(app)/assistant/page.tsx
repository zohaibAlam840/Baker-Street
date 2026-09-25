import Link from "next/link";

import { AnswerView } from "@/components/assistant/AnswerView";
import { Card, CardHeader } from "@/components/charts";
import { requirePermission } from "@/lib/auth/session";
import { answerQuestion } from "@/lib/ai/answer";
import { EXAMPLE_REQUESTS, interpret } from "@/lib/ai/interpret";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

/**
 * The assistant (spec sections 58-59), full screen.
 *
 * Same parser, same engine and the same `AnswerView` the chat widget uses —
 * this page is the wide version of that conversation, not a second
 * implementation of it. What it adds is the audit surface: the parsed request
 * printed in full, so the boundary the spec draws is visible rather than
 * claimed.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; week?: string }>;
}) {
  await requirePermission("schedule.search_availability");
  const { q, week } = await searchParams;

  const { ctx } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const request = q ? interpret(q, ctx) : null;
  const answer = request ? answerQuestion(ctx, request) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          Assistant
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-[var(--ink-secondary)]">
          Ask in plain English. The assistant turns your sentence into a
          scheduling request; the engine works out the answer. The same
          assistant is in the bottom-left corner of every screen.
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

      {answer && (
        <Card>
          <CardHeader title={answer.title} sub={answer.subtitle} />
          <div className="mt-4">
            <AnswerView answer={answer} />
          </div>
        </Card>
      )}

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
            answer above is the engine&rsquo;s.
          </p>
        </Card>
      )}

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
        decides. Replacing the parser with a model changes one file.
      </p>
    </div>
  );
}
