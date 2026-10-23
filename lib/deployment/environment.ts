import { readEnterpriseSsoConfig } from "../auth/sso";
import { readEhrConfig } from "../integrations/ehr/config";
import { guardianPortalEnabled } from "../portal/config";
import { readClaimsConfig } from "../integrations/claims/config";
import { readLlmAssistantConfig } from "../ai/llmConfig";
import { readMobileAssociationConfig } from "../mobile/config";

export type DeploymentTarget = "staging" | "production";

export interface EnvironmentValidation {
  errors: string[];
  warnings: string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "SCHEDULING_TIMEZONE",
] as const;

function value(env: Environment, name: string) {
  return env[name]?.trim() ?? "";
}

function requireHttpsOrigin(
  env: Environment,
  name: string,
  errors: string[],
) {
  const raw = value(env, name);
  if (!raw) return;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      errors.push(`${name} must be an HTTPS origin with no credentials, path, query, or fragment.`);
    }
  } catch {
    errors.push(`${name} must be a valid HTTPS origin.`);
  }
}

function validTimeZone(candidate: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateDeploymentEnvironment(
  env: Environment,
  target: DeploymentTarget,
): EnvironmentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of required) {
    if (!value(env, name)) errors.push(`${name} is required for ${target}.`);
  }

  requireHttpsOrigin(env, "NEXT_PUBLIC_SUPABASE_URL", errors);
  requireHttpsOrigin(env, "NEXT_PUBLIC_SITE_URL", errors);

  if (value(env, "USE_SYNTHETIC_DATA").toLowerCase() === "true") {
    errors.push("USE_SYNTHETIC_DATA must be false or absent outside local development.");
  }

  const publishableKey = value(env, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = value(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (
    publishableKey.startsWith("sb_secret_")
    || (serviceKey && publishableKey === serviceKey)
  ) {
    errors.push("The public Supabase key must never contain the service-role or secret key.");
  }

  const timeZone = value(env, "SCHEDULING_TIMEZONE");
  if (timeZone && !validTimeZone(timeZone)) {
    errors.push("SCHEDULING_TIMEZONE must be a valid IANA timezone.");
  }

  const subject = value(env, "VAPID_SUBJECT");
  if (subject && !/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\//.test(subject)) {
    errors.push("VAPID_SUBJECT must be a monitored mailto address or HTTPS URL.");
  }

  const release = value(env, "RELEASE_SHA") || value(env, "VERCEL_GIT_COMMIT_SHA");
  if (!release) errors.push("RELEASE_SHA or VERCEL_GIT_COMMIT_SHA is required for release traceability.");

  if (target === "production") {
    if (!serviceKey) {
      errors.push("SUPABASE_SERVICE_ROLE_KEY is required for production operational monitoring.");
    }
    const cronSecret = value(env, "CRON_SECRET");
    if (cronSecret.length < 16) {
      errors.push("CRON_SECRET must contain at least 16 characters for production operational monitoring.");
    }
  }

  for (const name of [
    "ALERT_EXPIRY_DAYS",
    "ALERT_COMMUNICATION_FAILURE_THRESHOLD",
    "ALERT_COMMUNICATION_BACKLOG_THRESHOLD",
    "ALERT_FAILED_SIGN_IN_THRESHOLD",
    "ALERT_OPTIMIZER_BOUNDED_THRESHOLD",
    "ALERT_PUSH_FAILURE_THRESHOLD",
  ]) {
    const raw = value(env, name);
    if (raw && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 10_000)) {
      errors.push(`${name} must be an integer between 1 and 10000.`);
    }
  }

  for (const [name, maximum] of [
    ["PUSH_DELIVERY_BATCH_SIZE", 100],
    ["PUSH_DELIVERY_CONCURRENCY", 10],
  ] as const) {
    const raw = value(env, name);
    if (raw && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > maximum)) {
      errors.push(`${name} must be an integer between 1 and ${maximum}.`);
    }
  }

  const delivery = value(env, "COMMUNICATIONS_DELIVERY_ENABLED").toLowerCase();
  if (delivery && delivery !== "true" && delivery !== "false") {
    errors.push("COMMUNICATIONS_DELIVERY_ENABLED must be true or false.");
  }
  if (delivery === "true") {
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SECRET",
      "COMMUNICATIONS_PUBLIC_BASE_URL",
    ]) {
      if (!value(env, name)) errors.push(`${name} is required when live communications are enabled.`);
    }
    requireHttpsOrigin(env, "COMMUNICATIONS_PUBLIC_BASE_URL", errors);

    const smsReady = Boolean(
      value(env, "TWILIO_ACCOUNT_SID")
      && value(env, "TWILIO_AUTH_TOKEN")
      && (value(env, "TWILIO_MESSAGING_SERVICE_SID") || value(env, "TWILIO_FROM_NUMBER")),
    );
    const emailReady = Boolean(
      value(env, "SENDGRID_API_KEY")
      && value(env, "SENDGRID_FROM_EMAIL")
      && value(env, "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"),
    );
    if (!smsReady && !emailReady) {
      errors.push("Live communications require one complete Twilio or SendGrid provider configuration.");
    }
  } else {
    warnings.push("Communications remain record-only until both live-delivery gates are approved.");
  }

  const solverUrl = value(env, "CP_SAT_SOLVER_URL");
  const solverSecret = value(env, "CP_SAT_SOLVER_SECRET");
  const solverRequired = value(env, "CP_SAT_REQUIRED").toLowerCase();
  if (solverRequired && solverRequired !== "true" && solverRequired !== "false") {
    errors.push("CP_SAT_REQUIRED must be true or false.");
  }
  if (solverUrl || solverSecret || solverRequired === "true") {
    if (!solverUrl) errors.push("CP_SAT_SOLVER_URL is required when CP-SAT is configured.");
    if (solverSecret.length < 24) {
      errors.push("CP_SAT_SOLVER_SECRET must contain at least 24 characters when CP-SAT is configured.");
    }
    requireHttpsOrigin(env, "CP_SAT_SOLVER_URL", errors);
  }
  for (const [name, minimum, maximum, integer] of [
    ["CP_SAT_TIMEOUT_MS", 500, 30_000, true],
    ["CP_SAT_MAX_CANDIDATES", 100, 12_000, true],
    ["CP_SAT_TIME_LIMIT_SECONDS", 0.25, 30, false],
  ] as const) {
    const raw = value(env, name);
    const parsed = Number(raw);
    if (raw && (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed)) || parsed < minimum || parsed > maximum)) {
      errors.push(`${name} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}.`);
    }
  }

  try {
    readEnterpriseSsoConfig(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Enterprise SSO configuration is invalid.");
  }
  try {
    readEhrConfig(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "EHR FHIR configuration is invalid.");
  }
  try {
    guardianPortalEnabled(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Guardian portal configuration is invalid.");
  }
  try {
    readClaimsConfig(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Claims adapter configuration is invalid.");
  }
  try {
    readLlmAssistantConfig(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "LLM assistant configuration is invalid.");
  }
  try {
    readMobileAssociationConfig(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Mobile association configuration is invalid.");
  }

  return { errors, warnings };
}
