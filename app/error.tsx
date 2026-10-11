"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Screen render failed", error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center p-6">
      <div className="card w-full p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--status-warning)]">Something went wrong</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--ink-primary)]">We could not load this screen.</h1>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">Your data was not changed. Try the request again, or return to the dashboard.</p>
        {error.digest && <p className="mt-2 text-xs text-[var(--ink-muted)]">Support reference: {error.digest}</p>}
        <div className="mt-5 flex gap-3">
          <button onClick={reset} className="rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white">Try again</button>
          <a href="/dashboard" className="rounded-full border border-[var(--border-ring)] px-4 py-2 text-sm">Dashboard</a>
        </div>
      </div>
    </main>
  );
}
