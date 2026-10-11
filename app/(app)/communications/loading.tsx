export default function CommunicationsLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="h-7 w-56 animate-pulse rounded bg-[var(--surface-sunken)]" />
      <div className="h-24 animate-pulse rounded-2xl bg-[var(--surface-sunken)]" />
      <div className="h-12 animate-pulse rounded-xl bg-[var(--surface-sunken)]" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-2xl bg-[var(--surface-sunken)]" />
        <div className="h-40 animate-pulse rounded-2xl bg-[var(--surface-sunken)]" />
      </div>
      <span className="sr-only">Loading the communication queue.</span>
    </div>
  );
}
