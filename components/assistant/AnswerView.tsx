import Link from "next/link";

import type { AssistantAnswer } from "@/lib/ai/answer";

/**
 * One engine answer, rendered.
 *
 * Shared by the chat widget and the full assistant page so the two cannot
 * disagree. It takes plain data and has no server-only imports, which is what
 * lets a client component pull it in.
 *
 * `compact` is the chat variant: the same content at chat-bubble scale.
 */
export function AnswerView({
  answer,
  compact = false,
  onNavigate,
}: {
  answer: AssistantAnswer;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const text = compact ? "text-[0.8125rem]" : "text-sm";

  return (
    <div className="space-y-3">
      <p className={`${text} leading-relaxed text-[var(--ink-primary)]`}>{answer.summary}</p>

      {answer.stats.length > 0 && (
        <dl
          className={[
            "grid gap-px overflow-hidden rounded-xl bg-[var(--border-ring)]",
            compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
          ].join(" ")}
        >
          {answer.stats.map((stat, index) => (
            <div
              key={stat.label}
              className={[
                "bg-[var(--surface-1)] px-3 py-2.5",
                // An odd last figure would otherwise leave a blank cell beside
                // it, which reads as a number that failed to load.
                index === answer.stats.length - 1 && answer.stats.length % 2 === 1
                  ? "col-span-2"
                  : "",
              ].join(" ")}
            >
              <dt className="text-[0.625rem] leading-tight text-[var(--ink-secondary)]">
                {stat.label}
              </dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-[var(--ink-primary)]">
                {stat.value}
              </dd>
              {stat.hint && (
                <dd className="mt-0.5 text-[0.625rem] leading-tight text-[var(--ink-muted)]">
                  {stat.hint}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}

      {answer.proposals.length > 0 && (
        <div>
          <h4 className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
            Suggested appointments
          </h4>
          <ul className="mt-1.5 space-y-1">
            {answer.proposals.map((proposal, index) => (
              <li
                key={`${proposal.when}-${index}`}
                className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-sunken)] px-2.5 py-1.5"
              >
                <span className="text-xs tabular-nums text-[var(--ink-primary)]">
                  {proposal.when}
                </span>
                <span className="text-[0.6875rem] text-[var(--ink-secondary)]">
                  {proposal.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.blockers.length > 0 && (
        <div>
          <h4 className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
            What is stopping it
          </h4>
          <ol className="mt-1.5 space-y-1">
            {answer.blockers.map((blocker, index) => (
              <li
                key={blocker}
                className="text-[0.6875rem] leading-relaxed text-[var(--ink-secondary)]"
              >
                {index + 1}. {blocker}
              </li>
            ))}
          </ol>
        </div>
      )}

      {answer.notes.length > 0 && (
        <ul className="space-y-1">
          {answer.notes.map((note) => (
            <li
              key={note}
              className="text-[0.6875rem] leading-relaxed text-[var(--ink-secondary)]"
            >
              {note}
            </li>
          ))}
        </ul>
      )}

      {answer.links.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {answer.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={onNavigate}
              className="rounded-full border border-[var(--border-ring)] px-2.5 py-1 text-[0.6875rem] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-primary)]"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}

      {answer.meta && (
        <p className="text-[0.625rem] leading-relaxed text-[var(--ink-muted)]">
          Computed by the scheduling engine in {answer.meta.runtime_ms}ms across{" "}
          {answer.meta.candidates} candidate appointments. Nothing was booked.
        </p>
      )}
    </div>
  );
}
