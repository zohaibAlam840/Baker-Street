import { createCommunicationServiceClient } from "@/lib/communications/delivery/service";
import {
  mapTwilioOptOutReceipt,
  mapTwilioStatusReceipt,
  verifyTwilioForm,
} from "@/lib/communications/delivery/receipts";
import { readWebhookBaseUrl } from "@/lib/communications/delivery/config";
import { logEvent } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 64 * 1024;

function twiml(status = 200) {
  return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", {
    status,
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return twiml(413);
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers.get("x-twilio-signature")?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  let publicBaseUrl: string;
  try {
    publicBaseUrl = readWebhookBaseUrl();
  } catch {
    return twiml(503);
  }
  if (!authToken || !signature || !supabaseUrl || !serviceRoleKey) return twiml(503);
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return twiml(413);
  const form = verifyTwilioForm({
    authToken,
    signature,
    requestUrl: request.url,
    publicBaseUrl,
    rawBody,
  });
  if (!form) {
    logEvent("warn", "communications.twilio_signature_rejected");
    return twiml(403);
  }

  const supabase = createCommunicationServiceClient(supabaseUrl, serviceRoleKey);
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const statusReceipt = mapTwilioStatusReceipt(form, token);
  if (statusReceipt) {
    const { error } = await supabase.rpc("record_communication_provider_receipt", {
      p_receipt_token: statusReceipt.receiptToken,
      p_provider: "TWILIO",
      p_provider_event_id: statusReceipt.providerEventId,
      p_receipt_type: statusReceipt.receiptType,
      p_occurred_at: statusReceipt.occurredAt,
      p_metadata: statusReceipt.metadata,
    });
    if (error) {
      logEvent("error", "communications.twilio_receipt_failed", {
        error_code: error.code ?? "RECEIPT_RECORD_FAILED",
      });
      return twiml(500);
    }
    return twiml();
  }

  const optOut = mapTwilioOptOutReceipt(form);
  if (optOut) {
    const { error } = await supabase.rpc("record_communication_destination_receipt", {
      p_channel: "SMS",
      p_destination: optOut.destination,
      p_provider: "TWILIO",
      p_provider_event_id: optOut.providerEventId,
      p_receipt_type: "OPT_OUT",
      p_occurred_at: optOut.occurredAt,
      p_metadata: optOut.metadata,
    });
    if (error) {
      logEvent("error", "communications.twilio_opt_out_failed", {
        error_code: error.code ?? "OPT_OUT_RECORD_FAILED",
      });
      return twiml(500);
    }
  }
  return twiml();
}

