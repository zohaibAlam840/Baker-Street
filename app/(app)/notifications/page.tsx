import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { formatDateOnly } from "@/lib/domain/time";
import { buildAlerts, groupAlerts, scopeAlerts } from "@/lib/scheduling/alerts";
import { defaultWeekStart, demoToday } from "@/lib/scheduling/defaults";
import { createClient } from "@/lib/supabase/server";
import { markNotificationRead } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  href: string | null;
  severity: string;
  user_id: string | null;
  read_at: string | null;
  created_at: string;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; error?: string; notice?: string }>;
}) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  const supabase = await createClient();
  const parsedPage = Number(query.page ?? "1");
  const page = Number.isInteger(parsedPage) ? Math.max(1, Math.min(parsedPage, 1_000)) : 1;
  const pageSize = 50;
  const offset = (page - 1) * pageSize;
  const [{ ctx }, notificationsResult] = await Promise.all([
    loadHorizon({ startDate: defaultWeekStart() }),
    supabase
      .from("notifications")
      .select("id,title,body,href,severity,user_id,read_at,created_at")
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize),
  ]);
  const loadedItems = (notificationsResult.data ?? []) as NotificationRow[];
  const hasOlder = loadedItems.length > pageSize;
  const items = loadedItems.slice(0, pageSize);
  const receiptsResult = items.length
    ? await supabase
        .from("notification_receipts")
        .select("notification_id,read_at")
        .eq("user_id", session.userId)
        .in("notification_id", items.map((item) => item.id))
    : { data: [], error: null };
  const readIds = new Set([
    ...(receiptsResult.data ?? []).map((row) => row.notification_id),
    ...items
      .filter((item) => item.user_id === session.userId && item.read_at)
      .map((item) => item.id),
  ]);
  const restricted = ["own", "caseload"].includes(ROLE_DEFINITIONS[session.role].scope);
  const alerts = groupAlerts(
    scopeAlerts(
      buildAlerts(ctx, formatDateOnly(demoToday(), ctx.grid.timeZone)),
      ctx,
      session.providerId,
      restricted,
    ),
  );
  const queryError = notificationsResult.error || receiptsResult.error;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-[var(--ink-primary)]">Work queue</h1>
        <p className="text-sm text-[var(--ink-secondary)]">Live operational warnings plus assigned follow-up tasks.</p>
      </div>
      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm">{query.notice}</p>}
      {queryError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">Assigned tasks could not be loaded. Try refreshing.</p>}

      <Card>
        <CardHeader title="Needs attention" sub={`${alerts.length} current`} />
        <div className="mt-3 divide-y divide-[var(--rule-hairline)]">
          {alerts.map((alert) => (
            <Link key={alert.id} href={alert.href} className="block min-h-11 py-3">
              <p className="text-sm font-medium text-[var(--ink-primary)]">{alert.severity === "critical" ? "● " : ""}{alert.title}</p>
              <p className="text-xs text-[var(--ink-secondary)]">{alert.detail}</p>
            </Link>
          ))}
          {alerts.length === 0 && <p className="py-6 text-sm text-[var(--ink-secondary)]">No live warnings.</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Assigned tasks" sub={`${items.filter((item) => !readIds.has(item.id)).length} unread on this page`} />
        <div className="mt-3 divide-y divide-[var(--rule-hairline)]">
          {items.map((item) => {
            const read = readIds.has(item.id);
            return (
              <article key={item.id} className={`py-3 ${read ? "opacity-60" : ""}`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--ink-primary)]">{item.title}</p>
                    <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">{item.body}</p>
                    <p className="mt-1 text-[0.6875rem] text-[var(--ink-muted)]">{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(item.created_at))}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.href && <Link href={item.href} className="grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-3 text-xs">Open</Link>}
                    {!read && (
                      <form action={markNotificationRead}>
                        <input type="hidden" name="notification_id" value={item.id} />
                        <ActionSubmit tone="secondary" pendingLabel="Saving…">Mark read</ActionSubmit>
                      </form>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
          {!items.length && !queryError && <p className="py-6 text-sm text-[var(--ink-secondary)]">No assigned tasks.</p>}
        </div>
        {(page > 1 || hasOlder) && (
          <nav aria-label="Assigned task pages" className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--rule-hairline)] pt-4 text-sm">
            {page > 1
              ? <Link href={`/notifications?page=${page - 1}`} className="grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4">Newer</Link>
              : <span />}
            <span className="text-xs text-[var(--ink-muted)]">Page {page}</span>
            {hasOlder
              ? <Link href={`/notifications?page=${page + 1}`} className="grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4">Older</Link>
              : <span />}
          </nav>
        )}
      </Card>
    </div>
  );
}
