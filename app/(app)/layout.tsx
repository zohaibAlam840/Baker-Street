import Link from "next/link";
import type { ReactNode } from "react";

import { AssistantWidget } from "@/components/shell/AssistantWidget";
import { BottomNav, SidebarNav } from "@/components/shell/Nav";
import { NotificationsMenu } from "@/components/shell/NotificationsMenu";
import {
  IconArrowUpRight,
  IconChart,
  IconLogo,
  IconSearch,
  IconUserPlus,
} from "@/components/shell/icons";
import { signOut } from "@/lib/auth/actions";
import { ROLE_DEFINITIONS, can, navFor, primaryNavFor } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { EXAMPLE_REQUESTS } from "@/lib/ai/interpret";
import { loadHorizon } from "@/lib/data/snapshot";
import { formatDateOnly } from "@/lib/domain/time";
import { buildAlerts, groupAlerts, scopeAlerts } from "@/lib/scheduling/alerts";
import { defaultWeekStart, demoToday } from "@/lib/scheduling/defaults";

/**
 * The signed-in shell.
 *
 * One layout, two shapes: a sidebar on desktop, a bottom tab bar on phones.
 * Navigation is built from the role's permissions, so a role never sees a link
 * to something it cannot do — the permission check on each page is what
 * actually enforces access; hiding the link avoids offering dead ends.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const definition = ROLE_DEFINITIONS[session.role];
  const nav = navFor(session.role);
  const primary = primaryNavFor(session.role);

  const today = demoToday();

  // The bell used to be a button with no handler. These are derived from
  // the current snapshot on each request, then narrowed to what this role
  // may see — the same scoping the dashboard uses.
  const { ctx } = await loadHorizon({ startDate: defaultWeekStart() });
  const alerts = groupAlerts(
    scopeAlerts(
    buildAlerts(ctx, formatDateOnly(today, ctx.grid.timeZone)),
    ctx,
    session.providerId,
      definition.scope === "own" || definition.scope === "caseload",
    ),
  );
  const dateLabel = today.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="min-h-dvh bg-[var(--surface-page)] lg:p-4">
      <div className="mx-auto flex min-h-dvh max-w-[96rem] overflow-hidden bg-[var(--surface-app)] lg:min-h-[calc(100dvh-2rem)] lg:rounded-[1.75rem] lg:shadow-[var(--shadow-float)]">
        {/* ---------------- Sidebar (desktop) ---------------- */}
        <aside className="hidden w-[16.5rem] shrink-0 flex-col gap-4 p-4 lg:flex">
          <div className="flex items-center gap-2 px-2 py-1">
            <IconLogo className="size-7 text-[var(--brand)]" />
            <span className="text-[0.95rem] font-semibold tracking-tight text-[var(--ink-primary)]">
              Baker Street
            </span>
          </div>

          <div className="card flex-1 overflow-y-auto p-2">
            <SidebarNav items={nav} />
          </div>

          {/* Who is signed in */}
          <div className="flex items-center gap-2.5 px-1">
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-sm font-semibold text-[var(--brand)]"
            >
              {session.name
                .split(" ")
                .map((part) => part[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--ink-primary)]">
                {session.name}
              </span>
              <span className="block truncate text-[0.6875rem] text-[var(--ink-muted)]">
                {definition.label}
              </span>
            </span>
            <form action={signOut}>
              <button
                type="submit"
                title="Sign out"
                aria-label="Sign out"
                className="grid size-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-primary)]"
              >
                <IconArrowUpRight className="size-4" />
              </button>
            </form>
          </div>

          {/*
            The assistant used to be promoted with a card down here. It is a
            chat widget pinned to the bottom-left now, which lands exactly on
            this spot — so this space is left clear for it rather than
            advertising the thing that is already visible.
          */}
          <div aria-hidden className="h-16 shrink-0" />
        </aside>

        {/* ---------------- Main column ---------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-30 border-b border-[var(--rule-hairline)] bg-[var(--surface-app)]/90 px-4 py-3 backdrop-blur lg:border-0 lg:bg-transparent lg:px-6 lg:py-4 lg:backdrop-blur-none">
            <div className="flex items-center gap-3">
              {/* Mobile brand */}
              <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
                <IconLogo className="size-6 text-[var(--brand)]" />
                <span className="text-sm font-semibold text-[var(--ink-primary)]">
                  Baker Street
                </span>
              </Link>

              {can(session.role, "view.patient_schedule") ? (
              <form action="/search" className="relative hidden min-w-0 flex-1 items-center lg:flex">
                <IconSearch className="pointer-events-none absolute left-3.5 size-4 text-[var(--ink-muted)]" />
                <label htmlFor="global-search" className="sr-only">
                  Search patients, clinicians and appointments
                </label>
                <input
                  id="global-search"
                  type="search"
                  name="q"
                  placeholder="Search patients, clinicians, appointments"
                  className="h-10 w-full rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] pl-10 pr-4 text-sm text-[var(--ink-primary)] outline-none placeholder:text-[var(--ink-muted)] focus:ring-2 focus:ring-[var(--brand-ring)]"
                />
              </form>
              ) : (
                <span className="hidden flex-1 lg:block" />
              )}

              <div className="ml-auto flex items-center gap-2">
                <NotificationsMenu alerts={alerts} />

                {can(session.role, "view.patient_schedule") && (
                <Link
                  href="/patients"
                  aria-label="Patients"
                  title="Patients"
                  className="hidden size-10 place-items-center rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)] lg:grid"
                >
                  <IconUserPlus className="size-[18px]" />
                </Link>
                )}

                <span className="hidden items-center gap-2 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 py-2 text-xs text-[var(--ink-secondary)] sm:flex">
                  {dateLabel}
                </span>

                {/* The reference's primary action. Ours goes to the reporting
                    view rather than claiming to generate a file. */}
                {can(session.role, "analytics.capacity") && (
                <Link
                  href="/capacity"
                  className="hidden items-center gap-2 rounded-full bg-[var(--brand)] px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-hover)] lg:flex"
                >
                  <IconChart className="size-4" />
                  Reports
                </Link>
                )}

                <span
                  aria-hidden
                  className="grid size-10 place-items-center rounded-full bg-[var(--brand-tint)] text-xs font-semibold text-[var(--brand)] lg:hidden"
                >
                  {session.name
                    .split(" ")
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join("")}
                </span>
              </div>
            </div>
          </header>

          {/* Demo banner — the sign-in verifies nothing, so say so everywhere. */}
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-[var(--surface-sunken)] px-3 py-2 lg:mx-6">
            <span
              aria-hidden
              className="inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: "var(--status-warning)" }}
            />
            <p className="text-[0.6875rem] leading-tight text-[var(--ink-secondary)]">
              Demo role switcher — not real authentication. Synthetic data only.
            </p>
          </div>

          {/* Bottom padding clears the floating assistant button on both breakpoints,
              so it never covers the last card on a long page. */}
          <main className="flex-1 px-4 pb-28 lg:px-6 lg:pb-24">{children}</main>
        </div>
      </div>

      {/* Reachable from every page, not just the assistant screen. */}
      {can(session.role, "schedule.search_availability") && (
        <AssistantWidget examples={EXAMPLE_REQUESTS} />
      )}

      <BottomNav items={primary} />
    </div>
  );
}
