import { NextResponse } from "next/server";

import { validateDeploymentEnvironment } from "@/lib/deployment/environment";
import { REQUIRED_SCHEMA_VERSION } from "@/lib/deployment/verification";
import { logEvent } from "@/lib/observability/logger";
import { readCpSatConfig } from "@/lib/scheduling/cpSatConfig";

export const dynamic = "force-dynamic";

type ComponentStatus = "available" | "degraded" | "unavailable" | "unconfigured";

interface SchemaStatus {
  ready?: boolean;
  version?: string;
  optimizer_approval?: boolean;
  optimizer_moves?: boolean;
  optimizer_decisions?: boolean;
  clinical_reductions?: boolean;
  provider_time_off?: boolean;
  provider_callout_guard?: boolean;
  access_management?: boolean;
  operational_monitoring?: boolean;
  push_delivery?: boolean;
  guardian_portal?: boolean;
  atomic_booking?: boolean;
  opaque_conflicts?: boolean;
  schedule_recovery?: boolean;
  communications?: boolean;
  communication_delivery?: boolean;
  configuration_writes?: boolean;
}

export async function GET() {
  const started = Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let auth: ComponentStatus = !url || !key ? "unconfigured" : "unavailable";
  let database: ComponentStatus = !url || !key ? "unconfigured" : "unavailable";
  let configuration: ComponentStatus = "available";
  let solver: ComponentStatus = "unconfigured";
  let solverRequired = false;
  let schema: SchemaStatus | null = null;

  try {
    const solverConfig = readCpSatConfig();
    solverRequired = solverConfig?.required ?? false;
    if (solverConfig) {
      solver = "unavailable";
      const response = await fetch(`${solverConfig.url}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      }).catch(() => null);
      if (response) {
        const payload = await response.json().catch(() => null) as { status?: unknown; contract?: unknown } | null;
        solver = response.ok && payload?.status === "ok" && payload.contract === "1"
          ? "available"
          : "degraded";
      }
    }
  } catch {
    solver = "unavailable";
    solverRequired = process.env.CP_SAT_REQUIRED?.trim().toLowerCase() === "true";
  }

  if (process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "production") {
    const target = process.env.VERCEL_ENV === "production" ? "production" : "staging";
    configuration = validateDeploymentEnvironment(process.env, target).errors.length === 0
      ? "available"
      : "degraded";
  }

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
        schema.optimizer_moves === true &&
        schema.optimizer_decisions === true &&
        schema.clinical_reductions === true &&
        schema.provider_time_off === true &&
        schema.provider_callout_guard === true &&
        schema.access_management === true &&
        schema.operational_monitoring === true &&
        schema.push_delivery === true &&
        schema.guardian_portal === true &&
        schema.atomic_booking === true &&
        schema.opaque_conflicts === true &&
        schema.schedule_recovery === true &&
        schema.communications === true &&
        schema.communication_delivery === true &&
        schema.configuration_writes === true;
      database = schemaReady ? "available" : "degraded";
    }
  }

  const healthy =
    auth === "available" &&
    database === "available" &&
    configuration === "available" &&
    (!solverRequired || solver === "available");
  const body = {
    status: healthy ? "ok" : "degraded",
    auth,
    database,
    configuration,
    solver,
    solver_required: solverRequired,
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
