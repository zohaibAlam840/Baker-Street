"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The assistant, playing out on the landing page.
 *
 * The figures in `script` are computed by the scheduling engine on the server
 * and passed in — this component only paces them. A marketing panel with
 * invented numbers, sitting beside a product whose whole claim is that its
 * numbers are real, would undercut the thing it is advertising.
 *
 * Under `prefers-reduced-motion` the whole exchange is there immediately; the
 * animation is pacing, never content.
 */

export interface ChatPreviewTurn {
  user: string;
  assistant: string;
  stats?: { label: string; value: string }[];
}

export function ChatPreview({ script }: { script: ChatPreviewTurn[] }) {
  // Two steps per turn: the question, then the answer.
  const total = script.length * 2;
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timers: number[] = [];

    // Reduced motion gets the whole exchange at once. Still scheduled rather
    // than set inline, so the initial render matches what the server sent.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      timers.push(window.setTimeout(() => setShown(total), 0));
      return () => timers.forEach(window.clearTimeout);
    }

    let delay = 600;

    for (let step = 0; step < total; step += 1) {
      const isAnswer = step % 2 === 1;
      if (isAnswer) {
        timers.push(window.setTimeout(() => setTyping(true), delay));
        delay += 900;
        timers.push(
          window.setTimeout(() => {
            setTyping(false);
            setShown(step + 1);
          }, delay),
        );
        delay += 2600;
      } else {
        timers.push(window.setTimeout(() => setShown(step + 1), delay));
        delay += 700;
      }
    }

    return () => timers.forEach(window.clearTimeout);
  }, [total]);

  // Follow the conversation down as it fills.
  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [shown, typing]);

  return (
    <div className="card overflow-hidden p-0">
      <div className="flex items-center gap-2.5 border-b border-[var(--rule-hairline)] px-4 py-3">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)]"
        >
          <span className="size-2 rounded-full bg-[var(--brand)]" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight text-[var(--ink-primary)]">
            Scheduling assistant
          </div>
          <div className="text-[0.625rem] text-[var(--ink-secondary)]">
            Engine-backed · no language model
          </div>
        </div>
      </div>

      <div
        ref={threadRef}
        className="h-[22rem] space-y-3 overflow-y-auto bg-[var(--surface-app)] p-4"
      >
        {script.flatMap((turn, index) => {
          const nodes = [];

          if (shown > index * 2) {
            nodes.push(
              <div key={`q-${index}`} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--brand)] px-3 py-2 text-[0.8125rem] leading-relaxed text-white">
                  {turn.user}
                </p>
              </div>,
            );
          }

          if (shown > index * 2 + 1) {
            nodes.push(
              <div key={`a-${index}`} className="flex justify-start">
                <div className="max-w-[92%] space-y-2.5 rounded-2xl rounded-bl-md border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-2.5">
                  <p className="text-[0.8125rem] leading-relaxed text-[var(--ink-primary)]">
                    {turn.assistant}
                  </p>
                  {turn.stats && turn.stats.length > 0 && (
                    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-[var(--border-ring)]">
                      {turn.stats.map((stat) => (
                        <div key={stat.label} className="bg-[var(--surface-1)] px-2.5 py-2">
                          <dt className="text-[0.625rem] leading-tight text-[var(--ink-secondary)]">
                            {stat.label}
                          </dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                            {stat.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>,
            );
          }

          return nodes;
        })}

        {typing && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-3">
              <span className="sr-only">Working it out</span>
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  aria-hidden
                  className="size-1.5 animate-bounce rounded-full bg-[var(--ink-muted)]"
                  style={{ animationDelay: `${index * 0.12}s` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--rule-hairline)] px-3 py-2.5">
        <span className="flex h-9 flex-1 items-center rounded-full border border-[var(--border-ring)] px-3.5 text-[0.8125rem] text-[var(--ink-muted)]">
          Ask your own question in the demo
        </span>
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--brand)] text-white"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none">
            <path
              d="M4 12h14M12 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
    </div>
  );
}
