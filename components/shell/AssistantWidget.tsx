"use client";

import { useEffect, useRef, useState } from "react";

import { AnswerView } from "@/components/assistant/AnswerView";
import type { AssistantAnswer } from "@/lib/ai/answer";
import { IconLogo, IconSpark } from "./icons";

/**
 * The assistant, as a chat.
 *
 * It used to be a launcher that handed the question to /assistant and let the
 * page answer — which meant asking anything threw away whatever screen you
 * were on. Now the widget holds a conversation: the question goes to
 * /api/assistant, the engine answers, and the answer lands in the thread next
 * to the work you were already doing.
 *
 * Bottom-left by request. On desktop it sits under the sidebar, where nothing
 * scrolls beneath it; on a phone it opens as a sheet above the tab bar.
 *
 * The honesty line in the header is not decoration. This looks exactly like a
 * chatbot, so the one thing it must never do is let someone assume a model is
 * thinking — a fixed-phrase parser picks the question, the engine computes
 * every number.
 */

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: AssistantAnswer;
  understood?: { intent: string; confidence: string };
  error?: boolean;
}

const STORAGE_KEY = "bsh_assistant_thread";

const GREETING: Turn = {
  id: "greeting",
  role: "assistant",
  text:
    "Ask me about a patient's hours, spare capacity, or what another hire would buy you. " +
    "I turn your sentence into a scheduling request — the engine works out the answer.",
};

export function AssistantWidget({ examples }: { examples: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [turns, setTurns] = useState<Turn[]>([GREETING]);
  const [pending, setPending] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Restore the conversation. A hard reload otherwise wipes it, and a chat
  // that forgets what you just asked is worse than no chat.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Turn[];
        if (Array.isArray(parsed) && parsed.length > 0) setTurns(parsed);
      }
    } catch {
      // Private mode, blocked storage — the greeting is a fine starting point.
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
    } catch {
      // Not worth interrupting a conversation over.
    }
  }, [turns]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the newest turn in view, including while the typing dots are up.
  useEffect(() => {
    if (!open) return;
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns, pending, open]);

  // Escape closes. A click outside does too — but not while a request is in
  // flight, because losing an answer you are waiting for feels like a fault.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (pending) return;
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      window.clearTimeout(id);
    };
  }, [open, pending]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    const id = `${Date.now()}`;
    setTurns((previous) => [...previous, { id, role: "user", text: trimmed }]);
    setValue("");
    setPending(true);

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: trimmed }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${response.status}).`);
      }

      const data = (await response.json()) as {
        answer: AssistantAnswer;
        understood: { intent: string; confidence: string };
      };

      setTurns((previous) => [
        ...previous,
        {
          id: `${id}-a`,
          role: "assistant",
          text: data.answer.title,
          answer: data.answer,
          understood: data.understood,
        },
      ]);
    } catch (error) {
      setTurns((previous) => [
        ...previous,
        {
          id: `${id}-e`,
          role: "assistant",
          text:
            error instanceof Error
              ? error.message
              : "Something went wrong reaching the engine.",
          error: true,
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  const fresh = turns.length <= 1;

  return (
    <div
      ref={panelRef}
      // Bottom-left. On a phone it clears the tab bar and its safe area; on
      // desktop it sits inside the app card rather than pinned to the browser
      // corner, which read as though it belonged to the window, not the app.
      className="fixed left-4 z-50 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-9 lg:left-9"
    >
      {open && (
        <div
          role="dialog"
          aria-label="Scheduling assistant"
          className="mb-3 flex w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--border-ring)] bg-[var(--surface-1)] shadow-[var(--shadow-float)] max-h-[min(34rem,calc(100dvh-11rem))] lg:max-h-[min(36rem,calc(100dvh-8rem))]"
        >
          {/* ---- header ---- */}
          <div className="flex items-start gap-2.5 border-b border-[var(--rule-hairline)] px-3.5 py-3">
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-[var(--brand)]"
            >
              <IconLogo className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold leading-tight text-[var(--ink-primary)]">
                Scheduling assistant
              </h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-[0.625rem] text-[var(--ink-secondary)]">
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: "var(--status-good, var(--brand))" }}
                />
                Engine-backed · no language model
              </p>
            </div>

            {!fresh && (
              <button
                type="button"
                onClick={() => setTurns([GREETING])}
                className="shrink-0 rounded-full px-2 py-1 text-[0.625rem] text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-primary)]"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-sunken)]"
            >
              <span aria-hidden>×</span>
            </button>
          </div>

          {/* ---- thread ---- */}
          <div
            ref={threadRef}
            className="flex-1 space-y-3 overflow-y-auto bg-[var(--surface-app)] px-3.5 py-3.5"
            aria-live="polite"
          >
            {turns.map((turn) =>
              turn.role === "user" ? (
                <div key={turn.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--brand)] px-3 py-2 text-[0.8125rem] leading-relaxed text-white">
                    {turn.text}
                  </p>
                </div>
              ) : (
                <div key={turn.id} className="flex justify-start">
                  <div
                    className={[
                      "max-w-[92%] rounded-2xl rounded-bl-md border px-3 py-2.5",
                      turn.error
                        ? "border-[var(--status-critical,var(--border-ring))] bg-[var(--surface-1)]"
                        : "border-[var(--border-ring)] bg-[var(--surface-1)]",
                    ].join(" ")}
                  >
                    {turn.answer ? (
                      <>
                        {turn.understood?.confidence === "low" && (
                          <p className="mb-2 text-[0.625rem] text-[var(--ink-muted)]">
                            Low confidence — check this is what you meant.
                          </p>
                        )}
                        <AnswerView
                          answer={turn.answer}
                          compact
                          onNavigate={() => setOpen(false)}
                        />
                      </>
                    ) : (
                      <p className="text-[0.8125rem] leading-relaxed text-[var(--ink-primary)]">
                        {turn.text}
                      </p>
                    )}
                  </div>
                </div>
              ),
            )}

            {pending && (
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

            {/* Suggestions, while the thread is still empty. */}
            {fresh && (
              <ul className="space-y-1.5 pt-1">
                {examples.slice(0, 4).map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => ask(example)}
                      className="w-full rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-2 text-left text-[0.6875rem] leading-snug text-[var(--ink-secondary)] transition-colors hover:border-[var(--brand)] hover:text-[var(--ink-primary)]"
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- composer ---- */}
          <form
            className="flex items-center gap-2 border-t border-[var(--rule-hairline)] px-3 py-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              ask(value);
            }}
          >
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={pending}
              placeholder="Get John to 30 hours of ABA"
              aria-label="Ask the scheduling assistant"
              className="h-10 min-w-0 flex-1 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-muted)] focus:ring-2 focus:ring-[var(--brand-ring)] disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={pending || !value.trim()}
              aria-label="Send"
              className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--brand)] text-white transition-colors hover:bg-[var(--brand-hover)] disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                <path
                  d="M4 12h14M12 5l7 7-7 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open scheduling assistant"}
        className="grid size-12 place-items-center rounded-full bg-[var(--brand)] text-white shadow-[var(--shadow-float)] transition-transform hover:bg-[var(--brand-hover)] active:scale-95"
      >
        <IconSpark className="size-5" />
      </button>
    </div>
  );
}
