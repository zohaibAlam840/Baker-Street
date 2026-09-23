import Link from "next/link";

import { ICONS } from "@/components/shell/icons";
import { signOut } from "@/lib/auth/actions";
import { ROLE_DEFINITIONS, navFor } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * The mobile "More" screen.
 *
 * The tab bar holds four destinations; everything else this role can reach
 * lives here, with the account controls. On desktop the sidebar already shows
 * all of it, so this page is only ever reached from the tab bar.
 */
export default async function MenuPage() {
  const session = await requireSession();
  const definition = ROLE_DEFINITIONS[session.role];
  const rest = navFor(session.role).slice(4);

  return (
    <div className="space-y-4">
      <div className="card flex items-center gap-3 p-4">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-base font-semibold text-[var(--brand)]"
        >
          {session.name
            .split(" ")
            .map((part) => part[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--ink-primary)]">
            {session.name}
          </div>
          <div className="truncate text-xs text-[var(--ink-muted)]">
            {definition.label} ·{" "}
            {definition.scope === "own"
              ? "own schedule"
              : definition.scope === "caseload"
                ? "own caseload"
                : "whole organisation"}
          </div>
        </div>
      </div>

      {rest.length > 0 && (
        <nav className="card divide-y divide-[var(--rule-hairline)] overflow-hidden p-0">
          {rest.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 px-4 py-3.5 active:bg-[var(--surface-sunken)]"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--surface-sunken)] text-[var(--ink-secondary)]">
                  <Icon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[var(--ink-primary)]">
                    {item.label}
                  </span>
                  <span className="block truncate text-xs text-[var(--ink-muted)]">
                    {item.description}
                  </span>
                </span>
                <span aria-hidden className="text-[var(--ink-muted)]">
                  ›
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      <div className="card divide-y divide-[var(--rule-hairline)] overflow-hidden p-0">
        <Link
          href="/login"
          className="flex items-center justify-between px-4 py-3.5 active:bg-[var(--surface-sunken)]"
        >
          <span className="text-sm text-[var(--ink-primary)]">Switch role</span>
          <span className="text-xs text-[var(--ink-muted)]">{definition.label}</span>
        </Link>
        <Link
          href="/"
          className="flex items-center justify-between px-4 py-3.5 active:bg-[var(--surface-sunken)]"
        >
          <span className="text-sm text-[var(--ink-primary)]">About this preview</span>
          <span aria-hidden className="text-[var(--ink-muted)]">
            ›
          </span>
        </Link>
        <form action={signOut}>
          <button
            type="submit"
            className="w-full px-4 py-3.5 text-left text-sm text-[var(--ink-primary)] active:bg-[var(--surface-sunken)]"
          >
            Sign out
          </button>
        </form>
      </div>

      <p className="px-1 text-[0.6875rem] leading-relaxed text-[var(--ink-muted)]">
        Demo role switcher — not real authentication, and every figure comes
        from synthetic data. Nothing here is a real patient.
      </p>
    </div>
  );
}
