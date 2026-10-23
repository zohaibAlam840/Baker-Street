import { isAuthorizedCronRequest } from "@/lib/operations/cron";
import { logEvent } from "@/lib/observability/logger";
import { runPushDelivery } from "@/lib/push/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const summary = await runPushDelivery();
    return Response.json(
      { ok: summary.failed === 0, ...summary },
      {
        status: summary.failed === 0 ? 200 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    const code = error instanceof Error
      ? error.message.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100)
      : "PUSH_DELIVERY_FAILED";
    logEvent("error", "push.delivery_batch_failed", { error_code: code });
    return Response.json(
      { ok: false, error: "Push delivery is unavailable." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export const GET = handle;
export const POST = handle;
