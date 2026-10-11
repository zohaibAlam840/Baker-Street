"use client";

import { useState, type FormEvent, type ReactNode } from "react";

export function PrototypeForm({
  children,
  label = "Save changes",
  message = "This workflow is ready for review. Connect authentication and the database write layer to save it.",
}: {
  children: ReactNode;
  label?: string;
  message?: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(message);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {children}
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--rule-hairline)] pt-4">
        <button
          type="submit"
          className="rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white"
        >
          {label}
        </button>
        <button
          type="reset"
          onClick={() => setNotice(null)}
          className="rounded-full border border-[var(--border-ring)] px-4 py-2 text-sm text-[var(--ink-secondary)]"
        >
          Reset
        </button>
        {notice && (
          <p role="status" className="text-sm text-[var(--status-warning)]">
            {notice}
          </p>
        )}
      </div>
    </form>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5 text-sm text-[var(--ink-secondary)]">
      <span className="font-medium text-[var(--ink-primary)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--ink-muted)]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--ink-primary)] outline-none focus:border-[var(--brand)]";

export function ReadinessNotice({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-4 py-3 text-sm text-[var(--ink-secondary)]">
      <strong className="font-medium text-[var(--ink-primary)]">Prototype workflow.</strong>{" "}
      {children ?? "The complete interface is available, but submitting will not change data until the secure write layer is connected."}
    </div>
  );
}
