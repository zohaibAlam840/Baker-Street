export default function RecoveryLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="h-7 w-56 animate-pulse rounded bg-[var(--surface-sunken)]" />
      <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-sunken)]" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-36 animate-pulse rounded-2xl bg-[var(--surface-sunken)]" />
        <div className="h-36 animate-pulse rounded-2xl bg-[var(--surface-sunken)]" />
      </div>
      <span className="sr-only">Loading recovery work.</span>
    </div>
  );
}

