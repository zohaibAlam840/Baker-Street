import { logEvent } from "@/lib/observability/logger";
import { isAuthorizedCronRequest } from "@/lib/operations/cron";
import {
  type OperationalIssue,
  type OperationalSnapshot,
  evaluateOperationalAlerts,
  readOperationalAlertConfig,
} from "@/lib/observability/operationalAlerts";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function daysFrom(date: Date, days: number) {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function publishWorkQueueIssues(
  issues: OperationalIssue[],
  now: Date,
) {
  if (issues.length === 0) return;
  const client = createServiceClient("baker-street-operational-alerts");
  const expiresAt = daysFrom(now, 2).toISOString();
  const day = dateOnly(now);

  for (const issue of issues) {
    const { error } = await client.from("notifications").insert({
      role: issue.targetRole,
      kind: "OPERATIONAL_ALERT",
      title: issue.title,
      body: issue.body,
      href: issue.href,
      severity: issue.severity.toUpperCase(),
      dedupe_key: `operational:${issue.code}:${day}`,
      expires_at: expiresAt,
    });
    if (error && error.code !== "23505") {
      throw new Error(error.code ?? "OPERATIONAL_NOTIFICATION_FAILED");
    }
  }
}

async function snapshot(now: Date): Promise<OperationalSnapshot> {
  const client = createServiceClient("baker-street-operational-alerts");
  const config = readOperationalAlertConfig(process.env);
  const today = dateOnly(now);
  const expiryEnd = dateOnly(daysFrom(now, config.expiryDays));
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const since15m = new Date(now.getTime() - 15 * 60 * 1_000).toISOString();

  const results = await Promise.all([
    client.from("authorizations").select("id", { count: "exact", head: true })
      .eq("status", "ACTIVE").lt("end_date", today),
    client.from("authorizations").select("id", { count: "exact", head: true })
      .eq("status", "ACTIVE").gte("end_date", today).lte("end_date", expiryEnd),
    client.from("provider_credentials").select("id", { count: "exact", head: true })
      .eq("status", "ACTIVE").not("expiration_date", "is", null).lt("expiration_date", today),
    client.from("provider_credentials").select("id", { count: "exact", head: true })
      .eq("status", "ACTIVE").gte("expiration_date", today).lte("expiration_date", expiryEnd),
    client.from("communication_jobs").select("id", { count: "exact", head: true })
      .eq("status", "FAILED").gte("updated_at", since24h),
    client.from("communication_jobs").select("id", { count: "exact", head: true })
      .in("status", ["QUEUED", "FAILED"]).lte("next_attempt_at", now.toISOString())
      .gt("expires_at", now.toISOString()),
    client.from("operational_events").select("id", { count: "exact", head: true })
      .eq("category", "AUTH_SIGN_IN_FAILED").gte("occurred_at", since15m),
    client.from("operational_events").select("id", { count: "exact", head: true })
      .eq("category", "OPTIMIZER_BOUNDED").gte("occurred_at", since24h),
    client.from("operational_events").select("id", { count: "exact", head: true })
      .eq("category", "PUSH_DELIVERY_FAILED").gte("occurred_at", since24h),
  ]);
  const failed = results.find(({ error }) => error);
  if (failed?.error) throw new Error(failed.error.code ?? "OPERATIONAL_SNAPSHOT_FAILED");
  const count = (index: number) => results[index].count ?? 0;

  const { error: purgeError } = await client
    .from("operational_events")
    .delete()
    .lt("occurred_at", daysFrom(now, -90).toISOString());
  if (purgeError) {
    logEvent("warn", "operational.event_retention_failed", {
      error_code: purgeError.code ?? "OPERATIONAL_EVENT_RETENTION_FAILED",
    });
  }

  return {
    active_authorizations_expired: count(0),
    active_authorizations_expiring: count(1),
    active_credentials_expired: count(2),
    active_credentials_expiring: count(3),
    communication_failures_24h: count(4),
    overdue_communication_jobs: count(5),
    failed_sign_ins_15m: count(6),
    optimizer_bounded_24h: count(7),
    push_failures_24h: count(8),
  };
}

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const now = new Date();
  try {
    const current = await snapshot(now);
    const result = evaluateOperationalAlerts(
      current,
      readOperationalAlertConfig(process.env),
    );
    await publishWorkQueueIssues(result.issues, now);

    for (const issue of result.issues) {
      logEvent(issue.severity === "critical" ? "error" : "warn", "operational.alert_triggered", {
        alert_code: issue.code,
        status: issue.severity,
        issue_count: issue.count,
      });
    }
    logEvent("info", "operational.alert_check_completed", {
      status: result.status,
      issue_count: result.issues.length,
    });

    return Response.json(
      {
        ok: result.status !== "critical",
        status: result.status,
        issues: result.issues.map(({ code, severity, count }) => ({ code, severity, count })),
        timestamp: now.toISOString(),
      },
      {
        status: result.status === "critical" ? 503 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    const code = error instanceof Error
      ? error.message.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100)
      : "OPERATIONAL_ALERT_CHECK_FAILED";
    logEvent("error", "operational.alert_check_failed", { error_code: code });
    return Response.json(
      { ok: false, status: "unavailable", error: "Operational checks are unavailable." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export const GET = handle;
export const POST = handle;
