export default function TimeOffLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading time-off requests">
      <div className="h-16 animate-pulse rounded-xl bg-[var(--surface-sunken)]" />
      <div className="h-72 animate-pulse rounded-xl bg-[var(--surface-sunken)]" />
      <div className="h-48 animate-pulse rounded-xl bg-[var(--surface-sunken)]" />
    </div>
  );
}
