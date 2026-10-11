import { NextResponse } from "next/server";

import { logEvent } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

const REQUIRED_SCHEMA_VERSION = "20261011031200";

type ComponentStatus = "available" | "degraded" | "unavailable" | "unconfigured";

interface SchemaStatus {
  ready?: boolean;
  version?: string;
  optimizer_approval?: boolean;
  atomic_booking?: boolean;
  opaque_conflicts?: boolean;
  schedule_recovery?: boolean;
  communications?: boolean;
}

export async function GET() {
  const started = Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let auth: ComponentStatus = !url || !key ? "unconfigured" : "unavailable";
  let database: ComponentStatus = !url || !key ? "unconfigured" : "unavailable";
  let schema: SchemaStatus | null = null;

  if (url && key) {
    const headers = {
      apikey: key,
      authorization: `Bearer ${key}`,
    };
    const [authResult, schemaResult] = await Promise.allSettled([
      fetch(`${url}/auth/v1/health`, {
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(4_000),
      }),
      fetch(`${url}/rest/v1/rpc/app_schema_status`, {
        method: "POST",
        cache: "no-store",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(4_000),
      }),
    ]);

    if (authResult.status === "fulfilled") {
      auth = authResult.value.ok ? "available" : "degraded";
    }
    if (schemaResult.status === "fulfilled") {
      schema = (await schemaResult.value.json().catch(() => null)) as SchemaStatus | null;
      const schemaReady =
        schemaResult.value.ok &&
        schema?.ready === true &&
        schema.version === REQUIRED_SCHEMA_VERSION &&
        schema.optimizer_approval === true &&
        schema.atomic_booking === true &&
        schema.opaque_conflicts === true &&
        schema.schedule_recovery === true &&
        schema.communications === true;
      database = schemaReady ? "available" : "degraded";
    }
  }

  const healthy = auth === "available" && database === "available";
  const body = {
    status: healthy ? "ok" : "degraded",
    auth,
    database,
    schema_version: schema?.version ?? null,
    release:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
      process.env.RELEASE_SHA ??
      "local",
    duration_ms: Date.now() - started,
    timestamp: new Date().toISOString(),
  };

  if (!healthy) logEvent("warn", "health.degraded", body);
  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
