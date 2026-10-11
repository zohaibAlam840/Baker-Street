"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { Alert } from "@/lib/scheduling/alerts";
import { IconBell } from "./icons";

const DOT: Record<string, string> = {
  critical: "var(--status-critical)",
  warning: "var(--status-warning)",
  info: "var(--ink-muted)",
};

export interface AssignedNotification {
  id: string;
  title: string;
  body: string;
  href: string | null;
  severity: string;
}

/** Compact preview of both computed safety alerts and unread assigned work. */
export function NotificationsMenu({
  alerts,
  tasks = [],
}: {
  alerts: Alert[];
  tasks?: AssignedNotification[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const urgent = alerts.filter((alert) => alert.severity !== "info").length + tasks.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      window.clearTimeout(id);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={urgent > 0 ? `Notifications, ${urgent} needing attention` : "Notifications"}
        className="relative grid size-10 place-items-center rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)]"
      >
        <IconBell className="size-[18px]" />
        {urgent > 0 && (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 grid min-w-[1.125rem] place-items-center rounded-full bg-[var(--status-critical)] px-1 text-[0.625rem] font-semibold text-white">
            {urgent > 9 ? "9+" : urgent}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Needs attention"
          className="fixed inset-x-4 top-16 z-50 max-h-[70dvh] overflow-y-auto rounded-2xl border border-[var(--border-ring)] bg-[var(--surface-1)] shadow-[var(--shadow-float)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-[24rem]"
        >
          <div className="sticky top-0 border-b border-[var(--rule-hairline)] bg-[var(--surface-1)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--ink-primary)]">Needs attention</h2>
            <p className="mt-0.5 text-[0.625rem] text-[var(--ink-secondary)]">Live safety alerts and assigned follow-up work</p>
          </div>

          {tasks.length > 0 && (
            <section aria-labelledby="bell-tasks-title">
              <h3 id="bell-tasks-title" className="px-4 pt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">Assigned tasks</h3>
              <ul className="divide-y divide-[var(--rule-hairline)]">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <Link href={task.href ?? "/notifications"} onClick={() => setOpen(false)} className="flex min-h-11 gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-sunken)]">
                      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: DOT[task.severity.toLowerCase()] ?? DOT.warning }} />
                      <span className="min-w-0">
                        <span className="block text-[0.8125rem] font-medium leading-snug text-[var(--ink-primary)]">{task.title}</span>
                        <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-[var(--ink-secondary)]">{task.body}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {alerts.length > 0 && (
            <section aria-labelledby="bell-alerts-title">
              <h3 id="bell-alerts-title" className="px-4 pt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">Live warnings</h3>
              <ul className="divide-y divide-[var(--rule-hairline)]">
                {alerts.map((alert) => (
                  <li key={alert.id}>
                    <Link href={alert.href} onClick={() => setOpen(false)} className="flex min-h-11 gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-sunken)]">
                      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: DOT[alert.severity] }} />
                      <span className="min-w-0">
                        <span className="block text-[0.8125rem] font-medium leading-snug text-[var(--ink-primary)]">{alert.title}</span>
                        <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-[var(--ink-secondary)]">{alert.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {alerts.length === 0 && tasks.length === 0 && <p className="px-4 py-6 text-sm text-[var(--ink-secondary)]">Nothing needs attention right now.</p>}
          <Link href="/notifications" onClick={() => setOpen(false)} className="grid min-h-11 place-items-center border-t border-[var(--rule-hairline)] px-4 text-xs font-medium text-[var(--brand)]">Open full work queue</Link>
          <p className="border-t border-[var(--rule-hairline)] px-4 py-2.5 text-[0.625rem] leading-relaxed text-[var(--ink-muted)]">Push alerts contain no patient details and are sent only when enabled on this device.</p>
        </div>
      )}
    </div>
  );
}
