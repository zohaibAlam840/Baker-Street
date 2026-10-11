"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function ActionSubmit({
  children,
  pendingLabel = "Saving…",
  tone = "primary",
  className = "",
  name,
  value,
}: {
  children: ReactNode;
  pendingLabel?: string;
  tone?: "primary" | "secondary" | "danger";
  className?: string;
  name?: string;
  value?: string;
}) {
  const { data, pending } = useFormStatus();
  const isActiveSubmitter = pending && (!name || data?.get(name) === value);
  const toneClass = tone === "danger"
    ? "bg-red-700 text-white"
    : tone === "secondary"
      ? "border border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-primary)]"
      : "bg-[var(--brand)] text-white";

  return (
    <>
      <button
        type="submit"
        name={name}
        value={value}
        disabled={pending}
        aria-disabled={pending}
        aria-busy={isActiveSubmitter}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-opacity disabled:cursor-wait disabled:opacity-60 ${toneClass} ${className}`}
      >
        {isActiveSubmitter && (
          <svg
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-90"
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="3"
            />
          </svg>
        )}
        <span>{isActiveSubmitter ? pendingLabel : children}</span>
      </button>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {isActiveSubmitter ? pendingLabel : ""}
      </span>
    </>
  );
}
