import { EventWebhook } from "@sendgrid/eventwebhook";
import twilio from "twilio";

import type { ProviderReceipt, ReceiptType } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalWebhookUrl(requestUrl: string, publicBaseUrl: string) {
  const incoming = new URL(requestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, publicBaseUrl).toString();
}

export function parseFormBody(rawBody: string) {
  const parsed = new URLSearchParams(rawBody);
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of parsed) {
    const existing = params[key];
    if (existing === undefined) params[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else params[key] = [existing, value];
  }
  return params;
}

export function verifyTwilioForm(params: {
  authToken: string;
  signature: string;
  requestUrl: string;
  publicBaseUrl: string;
  rawBody: string;
}) {
  try {
    const form = parseFormBody(params.rawBody);
    const valid = twilio.validateRequest(
      params.authToken,
      params.signature,
      canonicalWebhookUrl(params.requestUrl, params.publicBaseUrl),
      form,
    );
    return valid ? form : null;
  } catch {
    return null;
  }
}

function first(form: Record<string, string | string[]>, key: string) {
  const value = form[key];
  return Array.isArray(value) ? value[0] : value;
}

export interface TwilioStatusReceipt extends ProviderReceipt {
  receiptToken: string;
}

export function mapTwilioStatusReceipt(
  form: Record<string, string | string[]>,
  receiptToken: string,
  receivedAt = new Date(),
): TwilioStatusReceipt | null {
  if (!UUID.test(receiptToken)) return null;
  const messageSid = first(form, "MessageSid")?.trim();
  const status = first(form, "MessageStatus")?.trim().toLowerCase();
  const errorCode = first(form, "ErrorCode")?.trim();
  if (!messageSid || !/^SM[a-fA-F0-9]{32}$/.test(messageSid) || !status) return null;

  let receiptType: ReceiptType;
  if (errorCode === "21610" || errorCode === "30630") receiptType = "OPT_OUT";
  else if (status === "delivered" || status === "read") receiptType = "DELIVERED";
  else if (["failed", "undelivered", "canceled"].includes(status)) receiptType = "FAILED";
  else if (["accepted", "scheduled", "queued", "sending", "sent"].includes(status)) {
    receiptType = "ACCEPTED";
  } else return null;

  return {
    receiptToken,
    providerEventId: `status:${messageSid}:${status}:${errorCode || "none"}`,
    receiptType,
    occurredAt: receivedAt.toISOString(),
    metadata: { provider_status: status.toUpperCase().slice(0, 80) },
  };
}

export interface TwilioOptOutReceipt {
  destination: string;
  providerEventId: string;
  occurredAt: string;
  metadata: { provider_status: string };
}

export function mapTwilioOptOutReceipt(
  form: Record<string, string | string[]>,
  receivedAt = new Date(),
): TwilioOptOutReceipt | null {
  if (first(form, "OptOutType")?.trim().toUpperCase() !== "STOP") return null;
  const destination = first(form, "From")?.trim();
  const messageSid = first(form, "MessageSid")?.trim();
  if (!destination || !/^\+[1-9][0-9]{7,14}$/.test(destination)) return null;
  if (!messageSid || !/^SM[a-fA-F0-9]{32}$/.test(messageSid)) return null;
  return {
    destination,
    providerEventId: `opt-out:${messageSid}`,
    occurredAt: receivedAt.toISOString(),
    metadata: { provider_status: "STOP" },
  };
}

export function verifySendGridSignature(params: {
  publicKey: string;
  signature: string;
  timestamp: string;
  rawBody: string;
}) {
  try {
    const verifier = new EventWebhook();
    return verifier.verifySignature(
      verifier.convertPublicKeyToECDSA(params.publicKey),
      Buffer.from(params.rawBody),
      params.signature,
      params.timestamp,
    );
  } catch {
    return false;
  }
}

type SendGridEvent = Record<string, unknown>;

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sendGridToken(event: SendGridEvent) {
  const custom = event.custom_args;
  const nested =
    custom && typeof custom === "object"
      ? stringValue((custom as Record<string, unknown>).communication_receipt_token)
      : "";
  const value = nested || stringValue(event.communication_receipt_token);
  return UUID.test(value) ? value : null;
}

function sendGridReceiptType(event: SendGridEvent): {
  receiptType: ReceiptType;
  providerStatus: string;
} | null {
  const eventName = stringValue(event.event).toLowerCase().replaceAll("_", " ");
  if (eventName === "processed" || eventName === "deferred") {
    return { receiptType: "ACCEPTED", providerStatus: eventName.toUpperCase() };
  }
  if (eventName === "delivered") {
    return { receiptType: "DELIVERED", providerStatus: "DELIVERED" };
  }
  if (eventName === "spamreport" || eventName === "spam report") {
    return { receiptType: "COMPLAINT", providerStatus: "SPAM_REPORT" };
  }
  if (eventName === "unsubscribe" || eventName === "group unsubscribe") {
    return { receiptType: "OPT_OUT", providerStatus: "UNSUBSCRIBE" };
  }
  if (eventName === "bounce") {
    const type = stringValue(event.type).toLowerCase();
    if (type === "bounce") return { receiptType: "BOUNCED", providerStatus: "HARD_BOUNCE" };
    return { receiptType: "FAILED", providerStatus: "BLOCKED" };
  }
  if (eventName === "dropped") {
    const reason = stringValue(event.reason).toLowerCase();
    if (reason.includes("spam reporting")) {
      return { receiptType: "COMPLAINT", providerStatus: "SPAM_REPORT" };
    }
    if (reason.includes("unsubscribed")) {
      return { receiptType: "OPT_OUT", providerStatus: "UNSUBSCRIBE" };
    }
    if (reason.includes("bounced address")) {
      return { receiptType: "BOUNCED", providerStatus: "HARD_BOUNCE" };
    }
    return { receiptType: "FAILED", providerStatus: "DROPPED" };
  }
  return null;
}

export function parseSendGridReceipts(rawBody: string): ProviderReceipt[] {
  const parsed: unknown = JSON.parse(rawBody);
  if (!Array.isArray(parsed) || parsed.length > 500) {
    throw new Error("SendGrid event payload must be an array of at most 500 events.");
  }
  const receipts: ProviderReceipt[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as SendGridEvent;
    const receiptToken = sendGridToken(event);
    const mapped = sendGridReceiptType(event);
    const providerEventId = stringValue(event.sg_event_id);
    const timestamp =
      typeof event.timestamp === "number"
        ? event.timestamp
        : Number.parseInt(stringValue(event.timestamp), 10);
    if (!receiptToken || !mapped || !providerEventId || providerEventId.length > 240) continue;
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const occurredAt = new Date(timestamp * 1000);
    if (Number.isNaN(occurredAt.valueOf())) continue;
    receipts.push({
      receiptToken,
      providerEventId,
      receiptType: mapped.receiptType,
      occurredAt: occurredAt.toISOString(),
      metadata: { provider_status: mapped.providerStatus },
    });
  }
  return receipts;
}

