export default function ApprovalPlansLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">
          Multi-service optimizer
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
          Building safe plans
        </h1>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">
          Checking clinical targets, authorizations, staff, rooms, travel, and existing care.
        </p>
      </div>
      <div className="card space-y-3 p-4">
        <div className="h-4 w-40 animate-pulse rounded bg-[var(--surface-sunken)] motion-reduce:animate-none" />
        <div className="h-20 animate-pulse rounded-xl bg-[var(--surface-sunken)] motion-reduce:animate-none" />
        <div className="h-20 animate-pulse rounded-xl bg-[var(--surface-sunken)] motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Building schedule options. Please wait.</span>
    </div>
  );
}
