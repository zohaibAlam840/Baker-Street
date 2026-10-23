"use client";

export default function ErrorFallback({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const rawDigest = typeof error === "object" && error !== null && "digest" in error
    ? String(error.digest)
    : undefined;
  const digest = rawDigest && /^[a-zA-Z0-9._-]{1,128}$/.test(rawDigest)
    ? rawDigest
    : undefined;
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center p-6">
      <section className="card w-full p-6" role="alert">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--status-warning)]">
          Something went wrong
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--ink-primary)]">
          We could not load this screen.
        </h1>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">
          Your changes may not have been saved. Try again, or return to the dashboard.
        </p>
        {digest && (
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            Support reference: {digest}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <button
            className="rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white"
            onClick={() => retry()}
            type="button"
          >
            Try again
          </button>
          <a
            className="rounded-full border border-[var(--border-ring)] px-4 py-2 text-sm"
            href="/dashboard"
          >
            Dashboard
          </a>
        </div>
      </section>
    </main>
  );
}
