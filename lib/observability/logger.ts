type Level = "info" | "warn" | "error";

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 3;
const RESERVED_FIELDS = new Set([
  "timestamp",
  "level",
  "event",
  "environment",
  "release",
]);

const SAFE_DETAIL_FIELDS = new Set([
  "accepted",
  "alert_code",
  "attempted",
  "auth",
  "claimed",
  "configuration",
  "database",
  "delivered",
  "duration_ms",
  "error_code",
  "error_digest",
  "failed",
  "method",
  "ok",
  "processed",
  "removed",
  "revalidate_reason",
  "render_source",
  "render_type",
  "route_path",
  "route_type",
  "router_kind",
  "schema_version",
  "status",
  "suppressed",
  "optimizer_status",
  "plan_count",
  "runtime_ms",
  "solver",
  "solver_required",
]);

function safeText(value: string) {
  return value.replace(/[\r\n\t]/g, " ").slice(0, MAX_STRING_LENGTH);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return safeText(value);
  if (typeof value === "bigint") return value.toString();
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return sanitizeLogDetails(value as Record<string, unknown>, depth + 1);
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

/**
 * Keep logs useful while denying arbitrary application data by default.
 * New fields must be explicitly reviewed and added to SAFE_DETAIL_FIELDS.
 */
export function sanitizeLogDetails(
  details: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [rawKey, value] of Object.entries(details).slice(0, 50)) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
    if (!key || RESERVED_FIELDS.has(key) || value === undefined) continue;

    const countField = key.endsWith("_count") && typeof value === "number";
    sanitized[key] = SAFE_DETAIL_FIELDS.has(key) || countField
      ? sanitizeValue(value, depth)
      : REDACTED;
  }

  return sanitized;
}

function safeRuntimeValue(value: string | undefined, fallback: string) {
  return safeText(value ?? fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function logEvent(
  level: Level,
  event: string,
  details: Record<string, unknown> = {},
) {
  const safeEvent = /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(event)
    ? event
    : "invalid_event";
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event: safeEvent,
    environment: safeRuntimeValue(
      process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      "unknown",
    ),
    release: safeRuntimeValue(
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RELEASE_SHA,
      "local",
    ),
    ...sanitizeLogDetails(details),
  };
  const line = JSON.stringify(payload);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
