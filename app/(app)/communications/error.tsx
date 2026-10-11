"use client";

import Link from "next/link";

export default function CommunicationsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="card p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--status-warning)]">Communications paused</p>
        <h1 className="mt-2 text-xl font-semibold text-[var(--ink-primary)]">We could not load the delivery queue.</h1>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">No message was queued, retried or cancelled. Check your connection and try again.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={reset} className="min-h-11 rounded-full bg-[var(--brand)] px-4 text-sm font-medium text-white">Try again</button>
          <Link href="/dashboard" className="grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4 text-sm">Dashboard</Link>
        </div>
      </div>
    </div>
  );
}
