import type { DeliveryChannel } from "./types";

export class DeliveryConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryConfigurationError";
  }
}

export interface TwilioDeliveryConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string | null;
  fromNumber: string | null;
}

export interface SendGridDeliveryConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string | null;
  region: "GLOBAL" | "EU";
  eventWebhookPublicKey: string;
}

export interface DeliveryRuntimeConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  publicBaseUrl: string;
  batchSize: number;
  workerId: string;
  channels: DeliveryChannel[];
  twilio: TwilioDeliveryConfig | null;
  sendGrid: SendGridDeliveryConfig | null;
}

type Environment = Record<string, string | undefined>;

function present(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requireValue(env: Environment, name: string) {
  const value = present(env[name]);
  if (!value) {
    throw new DeliveryConfigurationError(
      "MISSING_DELIVERY_CONFIGURATION",
      `${name} is required for live communication delivery.`,
    );
  }
  return value;
}

function parsePublicBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeliveryConfigurationError(
      "INVALID_PUBLIC_BASE_URL",
      "COMMUNICATIONS_PUBLIC_BASE_URL must be an absolute HTTPS URL.",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new DeliveryConfigurationError(
      "INVALID_PUBLIC_BASE_URL",
      "COMMUNICATIONS_PUBLIC_BASE_URL must be an absolute HTTPS URL without credentials, a query, or a fragment.",
    );
  }
  return url.origin;
}

function parseBatchSize(value: string | undefined) {
  if (!value) return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new DeliveryConfigurationError(
      "INVALID_BATCH_SIZE",
      "COMMUNICATIONS_BATCH_SIZE must be an integer from 1 to 50.",
    );
  }
  return parsed;
}

function twilioConfig(env: Environment): TwilioDeliveryConfig | null {
  const names = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
    "TWILIO_FROM_NUMBER",
  ];
  if (!names.some((name) => present(env[name]))) return null;
  const accountSid = requireValue(env, "TWILIO_ACCOUNT_SID");
  const authToken = requireValue(env, "TWILIO_AUTH_TOKEN");
  const messagingServiceSid = present(env.TWILIO_MESSAGING_SERVICE_SID);
  const fromNumber = present(env.TWILIO_FROM_NUMBER);
  if (!messagingServiceSid && !fromNumber) {
    throw new DeliveryConfigurationError(
      "INCOMPLETE_TWILIO_CONFIGURATION",
      "Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.",
    );
  }
  if (!/^AC[a-fA-F0-9]{32}$/.test(accountSid)) {
    throw new DeliveryConfigurationError(
      "INVALID_TWILIO_ACCOUNT",
      "TWILIO_ACCOUNT_SID is not a valid Account SID.",
    );
  }
  if (messagingServiceSid && !/^MG[a-fA-F0-9]{32}$/.test(messagingServiceSid)) {
    throw new DeliveryConfigurationError(
      "INVALID_TWILIO_SENDER",
      "TWILIO_MESSAGING_SERVICE_SID is not a valid Messaging Service SID.",
    );
  }
  if (fromNumber && !/^\+[1-9][0-9]{7,14}$/.test(fromNumber)) {
    throw new DeliveryConfigurationError(
      "INVALID_TWILIO_SENDER",
      "TWILIO_FROM_NUMBER must be an E.164 number.",
    );
  }
  return { accountSid, authToken, messagingServiceSid, fromNumber };
}

function sendGridConfig(env: Environment): SendGridDeliveryConfig | null {
  const names = [
    "SENDGRID_API_KEY",
    "SENDGRID_FROM_EMAIL",
    "SENDGRID_FROM_NAME",
    "SENDGRID_REGION",
    "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  ];
  if (!names.some((name) => present(env[name]))) return null;
  const apiKey = requireValue(env, "SENDGRID_API_KEY");
  const fromEmail = requireValue(env, "SENDGRID_FROM_EMAIL").toLowerCase();
  const eventWebhookPublicKey = requireValue(env, "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY");
  const fromName = present(env.SENDGRID_FROM_NAME);
  const regionValue = present(env.SENDGRID_REGION)?.toUpperCase() ?? "GLOBAL";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail) || /[\r\n]/.test(fromEmail)) {
    throw new DeliveryConfigurationError(
      "INVALID_SENDGRID_SENDER",
      "SENDGRID_FROM_EMAIL must be a valid verified sender address.",
    );
  }
  if (eventWebhookPublicKey.length < 80 || eventWebhookPublicKey.length > 4_096) {
    throw new DeliveryConfigurationError(
      "INVALID_SENDGRID_WEBHOOK_KEY",
      "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is not a valid verification key.",
    );
  }
  if (fromName && (fromName.length > 100 || /[\r\n]/.test(fromName))) {
    throw new DeliveryConfigurationError(
      "INVALID_SENDGRID_SENDER",
      "SENDGRID_FROM_NAME must be at most 100 characters without line breaks.",
    );
  }
  if (regionValue !== "GLOBAL" && regionValue !== "EU") {
    throw new DeliveryConfigurationError(
      "INVALID_SENDGRID_REGION",
      "SENDGRID_REGION must be GLOBAL or EU.",
    );
  }
  return { apiKey, fromEmail, fromName, region: regionValue, eventWebhookPublicKey };
}

export function readDeliveryRuntimeConfig(
  env: Environment = process.env,
): DeliveryRuntimeConfig {
  if (present(env.COMMUNICATIONS_DELIVERY_ENABLED)?.toLowerCase() !== "true") {
    throw new DeliveryConfigurationError(
      "DELIVERY_DISABLED",
      "COMMUNICATIONS_DELIVERY_ENABLED must be true before the worker can claim messages.",
    );
  }
  const twilio = twilioConfig(env);
  const sendGrid = sendGridConfig(env);
  const channels: DeliveryChannel[] = [];
  if (twilio) channels.push("SMS");
  if (sendGrid) channels.push("EMAIL");
  if (channels.length === 0) {
    throw new DeliveryConfigurationError(
      "NO_DELIVERY_PROVIDERS",
      "Configure at least one approved SMS or email provider.",
    );
  }
  const invocation =
    present(env.VERCEL_REQUEST_ID) ?? present(env.GITHUB_RUN_ID) ?? crypto.randomUUID();
  return {
    supabaseUrl: requireValue(env, "NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: requireValue(env, "SUPABASE_SERVICE_ROLE_KEY"),
    publicBaseUrl: parsePublicBaseUrl(requireValue(env, "COMMUNICATIONS_PUBLIC_BASE_URL")),
    batchSize: parseBatchSize(env.COMMUNICATIONS_BATCH_SIZE),
    workerId: `communications-${invocation}`.slice(0, 100),
    channels,
    twilio,
    sendGrid,
  };
}

export function readWebhookBaseUrl(env: Environment = process.env) {
  return parsePublicBaseUrl(requireValue(env, "COMMUNICATIONS_PUBLIC_BASE_URL"));
}
