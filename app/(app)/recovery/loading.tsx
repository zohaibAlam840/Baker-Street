export default function RecoveryLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <div className="h-7 w-56 animate-pulse rounded bg-[var(--surface-sunken)] motion-reduce:animate-none" />
      <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-sunken)] motion-reduce:animate-none" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-36 animate-pulse rounded-2xl bg-[var(--surface-sunken)] motion-reduce:animate-none" />
        <div className="h-36 animate-pulse rounded-2xl bg-[var(--surface-sunken)] motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Loading recovery work.</span>
    </div>
  );
}
