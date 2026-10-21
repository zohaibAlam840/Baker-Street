import "server-only";

import { Client as SendGridClient } from "@sendgrid/client";
import { MailService } from "@sendgrid/mail";

import type { SendGridDeliveryConfig } from "./config";
import type {
  DeliveryProvider,
  PreparedCommunication,
  ProviderDeliveryResult,
} from "./types";

function headerValue(headers: unknown, name: string) {
  if (!headers || typeof headers !== "object") return null;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (Array.isArray(value)) return value.length ? String(value[0]).slice(0, 200) : null;
  return value == null ? null : String(value).slice(0, 200);
}

function errorResult(error: unknown): ProviderDeliveryResult {
  const value = error as { code?: unknown };
  const status = typeof value?.code === "number" ? value.code : null;
  const retryable = status === null || status === 408 || status === 429 || status >= 500;
  return {
    provider: "SENDGRID",
    providerMessageId: null,
    outcome: retryable ? "TEMPORARY_FAILURE" : "REJECTED",
    errorCategory: status ? `SENDGRID_HTTP_${status}` : "SENDGRID_REQUEST_FAILED",
    httpStatus: status,
    metadata: {},
  };
}

export function createSendGridProvider(config: SendGridDeliveryConfig): DeliveryProvider {
  const client = new SendGridClient();
  client.setApiKey(config.apiKey);
  client.setDataResidency(config.region === "EU" ? "eu" : "global");
  const sendGridMail = new MailService();
  sendGridMail.setClient(client);
  sendGridMail.setTimeout(10_000);
  return {
    name: "SENDGRID",
    async send(message: PreparedCommunication) {
      try {
        const [response] = await sendGridMail.send({
          to: message.destination,
          from: config.fromName
            ? { email: config.fromEmail, name: config.fromName }
            : config.fromEmail,
          subject: message.subject ?? "Scheduling update",
          text: message.body,
          customArgs: { communication_receipt_token: message.receipt_token },
          trackingSettings: {
            clickTracking: { enable: false, enableText: false },
            openTracking: { enable: false },
            subscriptionTracking: { enable: false },
          },
        });
        return {
          provider: "SENDGRID",
          providerMessageId: headerValue(response.headers, "x-message-id"),
          outcome: "ACCEPTED",
          errorCategory: null,
          httpStatus: response.statusCode,
          metadata: {
            provider_status: "ACCEPTED",
            provider_region: config.region,
          },
        } satisfies ProviderDeliveryResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
