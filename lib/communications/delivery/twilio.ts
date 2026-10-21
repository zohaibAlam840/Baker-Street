import "server-only";

import twilio from "twilio";

import type { TwilioDeliveryConfig } from "./config";
import type {
  DeliveryProvider,
  PreparedCommunication,
  ProviderDeliveryResult,
} from "./types";

function errorResult(error: unknown, message: PreparedCommunication): ProviderDeliveryResult {
  const value = error as { status?: unknown; code?: unknown };
  const status = typeof value?.status === "number" ? value.status : null;
  const providerCode =
    typeof value?.code === "number" || typeof value?.code === "string"
      ? String(value.code).slice(0, 20)
      : null;
  const retryable = status === null || status === 408 || status === 429 || status >= 500;
  const optedOut = providerCode === "21610" || providerCode === "30630";
  return {
    provider: "TWILIO",
    providerMessageId: null,
    outcome: retryable ? "TEMPORARY_FAILURE" : "REJECTED",
    errorCategory: providerCode ? `TWILIO_${providerCode}` : "TWILIO_REQUEST_FAILED",
    httpStatus: status,
    metadata: {},
    ...(optedOut
      ? {
          destinationReceipt: {
            providerEventId: `send-opt-out:${message.job_id}:${message.attempt_number}`,
            receiptType: "OPT_OUT" as const,
            metadata: { provider_status: `ERROR_${providerCode}` },
          },
        }
      : {}),
  };
}

export function createTwilioProvider(
  config: TwilioDeliveryConfig,
  publicBaseUrl: string,
): DeliveryProvider {
  const client = twilio(config.accountSid, config.authToken, {
    autoRetry: false,
    timeout: 10_000,
  });
  return {
    name: "TWILIO",
    async send(message: PreparedCommunication) {
      const statusCallback = new URL("/api/communications/webhooks/twilio", publicBaseUrl);
      statusCallback.searchParams.set("token", message.receipt_token);
      try {
        const result = await client.messages.create({
          to: message.destination,
          body: message.body,
          statusCallback: statusCallback.toString(),
          ...(config.messagingServiceSid
            ? { messagingServiceSid: config.messagingServiceSid }
            : { from: config.fromNumber! }),
        });
        const status = String(result.status ?? "accepted").toUpperCase().slice(0, 80);
        const delivered = status === "DELIVERED" || status === "READ";
        const failed = status === "FAILED" || status === "UNDELIVERED" || status === "CANCELED";
        return {
          provider: "TWILIO",
          providerMessageId: result.sid,
          outcome: delivered ? "DELIVERED" : failed ? "PERMANENT_FAILURE" : "ACCEPTED",
          errorCategory: failed ? `TWILIO_${status}` : null,
          httpStatus: 201,
          metadata: { provider_status: status },
        } satisfies ProviderDeliveryResult;
      } catch (error) {
        return errorResult(error, message);
      }
    },
  };
}
