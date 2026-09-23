import Link from "next/link";

import { addDays } from "@/lib/domain/time";

/**
 * Week navigation sits in one row above everything it scopes, rather than
 * inside any one panel — the grid, the tiles and the tables all re-render
 * against the same week.
 */
export function WeekNav({
  basePath,
  weekStart,
  synthetic,
}: {
  basePath: string;
  weekStart: string;
  synthetic: boolean;
}) {
  const weekEnd = addDays(weekStart, 6);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <NavLink href={`${basePath}?week=${addDays(weekStart, -7)}`} label="Previous week">
          {"←"}
        </NavLink>
        <span className="px-2 text-sm font-medium tabular-nums text-[var(--ink-primary)]">
          {weekStart} – {weekEnd}
        </span>
        <NavLink href={`${basePath}?week=${addDays(weekStart, 7)}`} label="Next week">
          {"→"}
        </NavLink>
      </div>

      {synthetic && (
        <span className="flex items-center gap-1.5 rounded-full border border-[var(--border-ring)] px-2.5 py-1 text-xs text-[var(--ink-secondary)]">
          <span
            aria-hidden
            className="inline-block size-1.5 rounded-full"
            style={{ background: "var(--status-warning)" }}
          />
          Synthetic data — no database connected
        </span>
      )}
    </div>
  );
}

function NavLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-md border border-[var(--border-ring)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-primary)]"
    >
      {children}
    </Link>
  );
}
