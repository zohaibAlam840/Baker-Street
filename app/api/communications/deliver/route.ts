import { DeliveryConfigurationError } from "@/lib/communications/delivery/config";
import { runCommunicationDelivery } from "@/lib/communications/delivery/worker";
import { logEvent } from "@/lib/observability/logger";
import { isAuthorizedCronRequest } from "@/lib/operations/cron";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
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
