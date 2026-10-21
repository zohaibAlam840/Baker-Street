import { createCommunicationServiceClient } from "@/lib/communications/delivery/service";
import {
  parseSendGridReceipts,
  verifySendGridSignature,
} from "@/lib/communications/delivery/receipts";
import { logEvent } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return new Response("Payload too large.", { status: 413 });
  }
  const signature = request.headers.get("x-twilio-email-event-webhook-signature")?.trim();
  const timestamp = request.headers.get("x-twilio-email-event-webhook-timestamp")?.trim();
  const publicKey = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!signature || !timestamp || !publicKey || !supabaseUrl || !serviceRoleKey) {
    return new Response("Webhook is not configured.", { status: 503 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return new Response("Payload too large.", { status: 413 });
  }
  if (!verifySendGridSignature({ publicKey, signature, timestamp, rawBody })) {
    logEvent("warn", "communications.sendgrid_signature_rejected");
    return new Response("Invalid signature.", { status: 403 });
  }

  let receipts;
  try {
    receipts = parseSendGridReceipts(rawBody);
  } catch {
    return new Response("Invalid payload.", { status: 400 });
  }
  const supabase = createCommunicationServiceClient(supabaseUrl, serviceRoleKey);
  for (const receipt of receipts) {
    const { error } = await supabase.rpc("record_communication_provider_receipt", {
      p_receipt_token: receipt.receiptToken,
      p_provider: "SENDGRID",
      p_provider_event_id: receipt.providerEventId,
      p_receipt_type: receipt.receiptType,
      p_occurred_at: receipt.occurredAt,
      p_metadata: receipt.metadata,
    });
    if (error) {
      logEvent("error", "communications.sendgrid_receipt_failed", {
        error_code: error.code ?? "RECEIPT_RECORD_FAILED",
      });
      return new Response("Receipt processing failed.", { status: 500 });
    }
  }
  return Response.json(
    { ok: true, processed: receipts.length },
    { headers: { "cache-control": "no-store" } },
  );
}

