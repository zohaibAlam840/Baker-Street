import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Audit log — honestly empty.
 *
 * The `audit_log` table exists in the schema and is indexed, but nothing
 * writes to it yet because Phase 1 makes no changes to commit. Showing an
 * empty table with an explanation is better than inventing sample entries: a
 * compliance screen that displays fabricated history is worse than no screen.
 */
export default async function AuditPage() {
  await requirePermission("audit.read");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">Audit log</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--ink-secondary)]">
          Every schedule change, who made it, what it replaced, and the reason
          given for any override.
        </p>
      </div>

      <div className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-6">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Nothing to show yet
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
          The audit table is built and indexed, but nothing has been written to
          it — Phase 1 is read-only, so there are no changes to record. Entries
          will start appearing as soon as the approval workflow can commit a
          schedule change.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
          Deliberately not showing sample rows here. A compliance screen that
          displays invented history is worse than an empty one.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          What each entry will hold
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {[
            ["Who", "The signed-in user who made the change"],
            ["What", "The appointment, patient and optimization run involved"],
            ["Before and after", "The full previous and new values, as stored JSON"],
            ["Override reason", "Required whenever a constraint was overridden"],
            ["When", "Timestamped, and append-only — nobody can edit history"],
            ["Why it ran", "The optimization request that produced the change"],
          ].map(([title, body]) => (
            <li
              key={title}
              className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3"
            >
              <span className="block text-sm font-medium text-[var(--ink-primary)]">
                {title}
              </span>
              <span className="block text-xs text-[var(--ink-secondary)]">{body}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-[var(--ink-secondary)]">
        The audit log must be append-only: no role, including administrators,
        should be able to alter or delete an entry once written.
      </p>
    </div>
  );
}
