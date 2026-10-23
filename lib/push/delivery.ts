import "server-only";

import webpush from "web-push";

import { recordOperationalEvent } from "@/lib/observability/events";
import { logEvent } from "@/lib/observability/logger";
import { createServiceClient } from "@/lib/supabase/service";

import { readPushDeliveryConfig } from "./config";
import {
  buildPrivatePushPayload,
  classifyPushFailure,
  pushTtl,
  type PushSeverity,
} from "./policy";

interface PushLease {
  delivery_id: string;
  processing_token: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  severity: PushSeverity;
  expires_at: string | null;
}

export interface PushDeliverySummary {
  claimed: number;
  accepted: number;
  retrying: number;
  permanentlyFailed: number;
  removedSubscriptions: number;
  failed: number;
}

function isPushSeverity(value: unknown): value is PushSeverity {
  return value === "INFO" || value === "WARNING" || value === "CRITICAL";
}

function isLease(value: unknown): value is PushLease {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.delivery_id === "string"
    && typeof row.processing_token === "string"
    && typeof row.endpoint === "string"
    && typeof row.p256dh === "string"
    && typeof row.auth === "string"
    && isPushSeverity(row.severity)
    && (row.expires_at === null || typeof row.expires_at === "string");
}

async function mapConcurrently<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await work(item);
      }
    },
  );
  await Promise.all(runners);
}

export async function runPushDelivery(): Promise<PushDeliverySummary> {
  const config = readPushDeliveryConfig();
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const client = createServiceClient("baker-street-push-delivery");
  const { data, error } = await client.rpc("claim_push_notification_deliveries", {
    p_limit: config.batchSize,
    p_worker_id: config.workerId,
  });
  if (error) throw new Error(error.code ?? "PUSH_DELIVERY_CLAIM_FAILED");
  const rows = Array.isArray(data) ? data : [];
  if (!rows.every(isLease)) throw new Error("INVALID_PUSH_DELIVERY_LEASE");
  const leases = rows as PushLease[];
  const summary: PushDeliverySummary = {
    claimed: leases.length,
    accepted: 0,
    retrying: 0,
    permanentlyFailed: 0,
    removedSubscriptions: 0,
    failed: 0,
  };

  async function record(
    lease: PushLease,
    outcome: "ACCEPTED" | "RETRY" | "PERMANENT_FAILURE",
    errorCode: string | null,
  ) {
    const result = await client.rpc("record_push_notification_delivery", {
      p_delivery_id: lease.delivery_id,
      p_processing_token: lease.processing_token,
      p_outcome: outcome,
      p_error_code: errorCode,
    });
    if (result.error) throw new Error(result.error.code ?? "PUSH_DELIVERY_RECORD_FAILED");
    return result.data as string;
  }

  await mapConcurrently(leases, config.concurrency, async (lease) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: lease.endpoint,
          keys: { p256dh: lease.p256dh, auth: lease.auth },
        },
        buildPrivatePushPayload(lease.delivery_id, lease.severity),
        {
          TTL: pushTtl(lease.expires_at),
          urgency: lease.severity === "CRITICAL" ? "high" : "normal",
          timeout: 10_000,
        },
      );
      await record(lease, "ACCEPTED", null);
      summary.accepted += 1;
    } catch (sendError) {
      const failure = classifyPushFailure(sendError);
      try {
        const finalStatus = await record(
          lease,
          failure.outcome,
          failure.errorCode,
        );
        if (finalStatus === "RETRY") summary.retrying += 1;
        else summary.permanentlyFailed += 1;

        if (failure.removeSubscription) {
          const removal = await client
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", lease.endpoint);
          if (removal.error) {
            summary.failed += 1;
            logEvent("warn", "push.subscription_cleanup_failed", {
              error_code: removal.error.code ?? "PUSH_SUBSCRIPTION_CLEANUP_FAILED",
            });
          } else {
            summary.removedSubscriptions += 1;
          }
        }
      } catch (recordError) {
        summary.failed += 1;
        logEvent("error", "push.delivery_outcome_failed", {
          error_code: recordError instanceof Error
            ? recordError.message.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100)
            : "PUSH_DELIVERY_OUTCOME_FAILED",
        });
      }
    }
  });

  const deliveryFailures = summary.retrying + summary.permanentlyFailed + summary.failed;
  if (deliveryFailures > 0) {
    await recordOperationalEvent("PUSH_DELIVERY_FAILED", deliveryFailures);
  }
  logEvent(deliveryFailures > 0 ? "warn" : "info", "push.delivery_batch_completed", {
    ...summary,
  });
  return summary;
}
