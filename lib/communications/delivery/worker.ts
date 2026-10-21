import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logEvent } from "@/lib/observability/logger";

import { readDeliveryRuntimeConfig } from "./config";
import { createSendGridProvider } from "./sendgrid";
import { createCommunicationServiceClient } from "./service";
import { createTwilioProvider } from "./twilio";
import type {
  DeliveryChannel,
  DeliveryProvider,
  PreparedCommunication,
  ProviderDeliveryResult,
} from "./types";

interface Lease {
  job_id: string;
  processing_token: string;
  attempt_number: number;
  lease_expires_at: string;
}

interface PreparationNotReady {
  ready: false;
  reason?: string;
  status?: string;
}

export interface DeliveryRunSummary {
  claimed: number;
  accepted: number;
  delivered: number;
  failed: number;
  suppressed: number;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function preparedCommunication(value: unknown): PreparedCommunication | PreparationNotReady {
  if (!value || typeof value !== "object") throw new Error("INVALID_PREPARATION_RESULT");
  const row = value as Record<string, unknown>;
  if (row.ready === false) {
    return {
      ready: false,
      reason: typeof row.reason === "string" ? row.reason : undefined,
      status: typeof row.status === "string" ? row.status : undefined,
    };
  }
  if (
    row.ready !== true ||
    !isUuid(row.job_id) ||
    !isUuid(row.processing_token) ||
    !isUuid(row.receipt_token) ||
    (row.channel !== "SMS" && row.channel !== "EMAIL") ||
    typeof row.destination !== "string" ||
    typeof row.destination_hash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(row.destination_hash) ||
    typeof row.body !== "string" ||
    typeof row.message_type !== "string" ||
    typeof row.expires_at !== "string" ||
    typeof row.attempt_number !== "number"
  ) {
    throw new Error("INVALID_PREPARATION_RESULT");
  }
  return row as unknown as PreparedCommunication;
}

async function recordOutcome(
  supabase: SupabaseClient,
  message: PreparedCommunication,
  result: ProviderDeliveryResult,
  startedAt: string,
  completedAt: string,
) {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase.rpc("record_communication_delivery_outcome", {
      p_job_id: message.job_id,
      p_processing_token: message.processing_token,
      p_provider: result.provider,
      p_provider_message_id: result.providerMessageId,
      p_outcome: result.outcome,
      p_error_category: result.errorCategory,
      p_http_status: result.httpStatus,
      p_destination_hash: message.destination_hash,
      p_started_at: startedAt,
      p_completed_at: completedAt,
      p_metadata: result.metadata,
    });
    if (!error) return;
    lastError = error.code ?? "OUTCOME_RECORD_FAILED";
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
  }
  throw new Error(lastError ?? "OUTCOME_RECORD_FAILED");
}

async function recordDestinationReceipt(
  supabase: SupabaseClient,
  message: PreparedCommunication,
  result: ProviderDeliveryResult,
  occurredAt: string,
) {
  if (!result.destinationReceipt) return;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase.rpc("record_communication_destination_receipt", {
      p_channel: message.channel,
      p_destination: message.destination,
      p_provider: result.provider,
      p_provider_event_id: result.destinationReceipt.providerEventId,
      p_receipt_type: result.destinationReceipt.receiptType,
      p_occurred_at: occurredAt,
      p_metadata: result.destinationReceipt.metadata,
    });
    if (!error) return;
    lastError = error.code ?? "DESTINATION_RECEIPT_FAILED";
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
  }
  throw new Error(lastError ?? "DESTINATION_RECEIPT_FAILED");
}

async function processLease(
  supabase: SupabaseClient,
  lease: Lease,
  providers: Map<DeliveryChannel, DeliveryProvider>,
) {
  const { data, error } = await supabase.rpc("prepare_communication_provider_delivery", {
    p_job_id: lease.job_id,
    p_processing_token: lease.processing_token,
  });
  if (error) throw new Error(error.code ?? "PREPARATION_FAILED");
  const prepared = preparedCommunication(data);
  if (!prepared.ready) return { kind: "suppressed" as const, reason: prepared.reason ?? "NOT_READY" };
  const provider = providers.get(prepared.channel);
  if (!provider) throw new Error("PROVIDER_NOT_CONFIGURED_FOR_CLAIMED_CHANNEL");
  const startedAt = new Date().toISOString();
  let result: ProviderDeliveryResult;
  try {
    result = await provider.send(prepared);
  } catch {
    result = {
      provider: provider.name,
      providerMessageId: null,
      outcome: "TEMPORARY_FAILURE",
      errorCategory: "PROVIDER_ADAPTER_FAILED",
      httpStatus: null,
      metadata: {},
    };
  }
  const completedAt = new Date().toISOString();
  await recordOutcome(supabase, prepared, result, startedAt, completedAt);
  await recordDestinationReceipt(supabase, prepared, result, completedAt);
  if (result.outcome === "ACCEPTED") return { kind: "accepted" as const };
  if (result.outcome === "DELIVERED") return { kind: "delivered" as const };
  return { kind: "failed" as const };
}

export async function runCommunicationDelivery(): Promise<DeliveryRunSummary> {
  const config = readDeliveryRuntimeConfig();
  const supabase = createCommunicationServiceClient(config.supabaseUrl, config.serviceRoleKey);
  const { data: mode, error: modeError } = await supabase.rpc("communication_delivery_mode");
  if (modeError) throw new Error(modeError.code ?? "DELIVERY_MODE_CHECK_FAILED");
  if (mode !== "LIVE") throw new Error("DATABASE_DELIVERY_MODE_IS_NOT_LIVE");

  const providers = new Map<DeliveryChannel, DeliveryProvider>();
  if (config.twilio) providers.set("SMS", createTwilioProvider(config.twilio, config.publicBaseUrl));
  if (config.sendGrid) providers.set("EMAIL", createSendGridProvider(config.sendGrid));

  const [reconcileResult, releaseResult] = await Promise.all([
    supabase.rpc("sync_upcoming_appointment_reminders", { p_horizon_days: 31, p_limit: 200 }),
    supabase.rpc("release_stale_communication_leases", { p_limit: 100 }),
  ]);
  if (reconcileResult.error) {
    logEvent("warn", "communications.reconciliation_failed", {
      error_code: reconcileResult.error.code ?? "RECONCILIATION_FAILED",
    });
  }
  if (releaseResult.error) {
    logEvent("warn", "communications.lease_release_failed", {
      error_code: releaseResult.error.code ?? "LEASE_RELEASE_FAILED",
    });
  }

  const { data, error } = await supabase.rpc("claim_communication_jobs_for_channels", {
    p_limit: config.batchSize,
    p_worker_id: config.workerId,
    p_channels: config.channels,
  });
  if (error) throw new Error(error.code ?? "DELIVERY_CLAIM_FAILED");
  const leases = (Array.isArray(data) ? data : []) as Lease[];
  const results = await Promise.allSettled(
    leases.map((lease) => processLease(supabase, lease, providers)),
  );
  const summary: DeliveryRunSummary = {
    claimed: leases.length,
    accepted: 0,
    delivered: 0,
    failed: 0,
    suppressed: 0,
  };
  for (const result of results) {
    if (result.status === "rejected") {
      summary.failed += 1;
      logEvent("error", "communications.delivery_job_failed", {
        error_code: result.reason instanceof Error ? result.reason.message.slice(0, 100) : "UNKNOWN",
      });
      continue;
    }
    summary[result.value.kind] += 1;
  }
  logEvent("info", "communications.delivery_batch_completed", { ...summary });
  return summary;
}
