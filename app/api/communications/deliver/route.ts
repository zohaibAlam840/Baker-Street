import { timingSafeEqual } from "node:crypto";

import { DeliveryConfigurationError } from "@/lib/communications/delivery/config";
import { runCommunicationDelivery } from "@/lib/communications/delivery/worker";
import { logEvent } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization");
  if (!secret || secret.length < 16 || !supplied?.startsWith("Bearer ")) return false;
  const expectedBuffer = Buffer.from(`Bearer ${secret}`);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const summary = await runCommunicationDelivery();
    return Response.json(
      { ok: true, ...summary },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const code =
      error instanceof DeliveryConfigurationError
        ? error.code
        : error instanceof Error
          ? error.message.slice(0, 100)
          : "DELIVERY_RUN_FAILED";
    logEvent("error", "communications.delivery_batch_failed", { error_code: code });
    return Response.json(
      { ok: false, error: code },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export const GET = handle;
export const POST = handle;

