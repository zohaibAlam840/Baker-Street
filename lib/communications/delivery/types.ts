export type DeliveryChannel = "SMS" | "EMAIL";
export type DeliveryOutcome =
  | "ACCEPTED"
  | "DELIVERED"
  | "TEMPORARY_FAILURE"
  | "PERMANENT_FAILURE"
  | "REJECTED";
export type ReceiptType =
  | "ACCEPTED"
  | "DELIVERED"
  | "BOUNCED"
  | "FAILED"
  | "COMPLAINT"
  | "OPT_OUT";

export interface PreparedCommunication {
  ready: true;
  job_id: string;
  processing_token: string;
  receipt_token: string;
  attempt_number: number;
  channel: DeliveryChannel;
  destination: string;
  destination_hash: string;
  message_type: string;
  subject: string | null;
  body: string;
  expires_at: string;
}

export interface ProviderDeliveryResult {
  provider: "TWILIO" | "SENDGRID";
  providerMessageId: string | null;
  outcome: DeliveryOutcome;
  errorCategory: string | null;
  httpStatus: number | null;
  metadata: {
    provider_status?: string;
    provider_region?: string;
  };
  destinationReceipt?: {
    providerEventId: string;
    receiptType: "OPT_OUT";
    metadata: { provider_status: string };
  };
}

export interface DeliveryProvider {
  readonly name: ProviderDeliveryResult["provider"];
  send(message: PreparedCommunication): Promise<ProviderDeliveryResult>;
}

export interface ProviderReceipt {
  receiptToken: string;
  providerEventId: string;
  receiptType: ReceiptType;
  occurredAt: string;
  metadata: {
    provider_status?: string;
  };
}
