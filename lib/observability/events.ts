import "server-only";

import { logEvent } from "./logger";
import { createServiceClient } from "../supabase/service";

export type OperationalEventCategory =
  | "AUTH_SIGN_IN_FAILED"
  | "OPTIMIZER_BOUNDED"
  | "PUSH_DELIVERY_FAILED";

export async function recordOperationalEvent(
  category: OperationalEventCategory,
  quantity = 1,
) {
  const boundedQuantity = Math.max(1, Math.min(100, Math.trunc(quantity)));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return false;

  const rawRelease = process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.RELEASE_SHA?.trim()
    || "local";
  const release = rawRelease.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const rows = Array.from({ length: boundedQuantity }, () => ({ category, release }));
  const { error } = await createServiceClient("baker-street-operational-events")
    .from("operational_events")
    .insert(rows);
  if (error) {
    logEvent("error", "operational.event_record_failed", {
      error_code: error.code ?? "OPERATIONAL_EVENT_INSERT_FAILED",
    });
    return false;
  }
  return true;
}
