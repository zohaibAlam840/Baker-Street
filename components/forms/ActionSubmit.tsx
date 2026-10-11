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
  const { pending } = useFormStatus();
  const toneClass = tone === "danger"
    ? "bg-red-700 text-white"
    : tone === "secondary"
      ? "border border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-primary)]"
      : "bg-[var(--brand)] text-white";

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-disabled={pending}
      className={`min-h-11 rounded-full px-4 text-sm font-medium transition-opacity disabled:cursor-wait disabled:opacity-60 ${toneClass} ${className}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
