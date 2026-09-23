"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { IconSpark } from "./icons";

/**
 * The assistant, reachable from anywhere.
 *
 * A launcher pinned above the tab bar on phones and clear of it on desktop.
 * Submitting hands off to /assistant — the widget never answers anything
 * itself, which keeps a single place where a question becomes a structured
 * request and the engine replies.
 */
export function AssistantWidget({ examples }: { examples: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the field when the panel opens, so it is usable without a second tap.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes; so does a click outside. Both are expected of a popover.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    // Deferred so the click that opened the panel does not immediately close it.
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      window.clearTimeout(id);
    };
  }, [open]);

  function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;
    setOpen(false);
    setValue("");
    router.push(`/assistant?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <div
      ref={panelRef}
      // Clear of the mobile tab bar, and of the safe area beneath it.
      className="fixed right-4 z-50 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-6 lg:right-6"
    >
      {open && (
        <div
          role="dialog"
          aria-label="Scheduling assistant"
          className="mb-3 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-[var(--border-ring)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-float)]"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[var(--ink-primary)]">
                Scheduling assistant
              </h2>
              <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-[var(--ink-secondary)]">
                Ask in plain English. The engine works out the answer.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-sunken)]"
            >
              <span aria-hidden>×</span>
            </button>
          </div>

          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              ask(value);
            }}
          >
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Get John to 30 hours of ABA"
              className="h-10 min-w-0 flex-1 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 text-sm outline-none placeholder:text-[var(--ink-muted)] focus:ring-2 focus:ring-[var(--brand-ring)]"
            />
            <button
              type="submit"
              className="h-10 shrink-0 rounded-full bg-[var(--brand)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
            >
              Ask
            </button>
          </form>

          <ul className="mt-3 space-y-1.5">
            {examples.slice(0, 3).map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => ask(example)}
                  className="w-full rounded-xl bg-[var(--surface-sunken)] px-3 py-2 text-left text-[0.6875rem] leading-snug text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)]"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-[0.625rem] leading-relaxed text-[var(--ink-muted)]">
            No language model is connected — a fixed-phrase parser turns your
            sentence into a scheduling request, and the engine answers it.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open assistant"}
        // Icon only, and circular: a labelled pill is wider, and this floats
        // over the right-hand edge of every list — where status badges and
        // figures live. It was covering them.
        className="ml-auto grid size-12 place-items-center rounded-full bg-[var(--brand)] text-white shadow-[var(--shadow-float)] transition-colors hover:bg-[var(--brand-hover)]"
      >
        <IconSpark className="size-5" />
      </button>
    </div>
  );
}
