import { REQUIRED_SCHEMA_VERSION } from "../deployment/verification";

export const RECOVERY_MANIFEST_VERSION = 1;

export interface RecoveryTableSummary {
  rows: number;
  hmac: string;
}

export interface RecoveryManifest {
  format_version: number;
  schema_version: string;
  source_host: string;
  captured_at: string;
  tables: Record<string, RecoveryTableSummary>;
  auth_users: RecoveryTableSummary;
}

export interface RecoveryTableSpec {
  name: string;
  orderBy: string[];
}

export const RECOVERY_TABLES: RecoveryTableSpec[] = [
  { name: "locations", orderBy: ["id"] },
  { name: "patients", orderBy: ["id"] },
  { name: "services", orderBy: ["id"] },
  { name: "service_durations", orderBy: ["id"] },
  { name: "service_requirements", orderBy: ["id"] },
  { name: "patient_service_requirements", orderBy: ["id"] },
  { name: "authorizations", orderBy: ["id"] },
  { name: "providers", orderBy: ["id"] },
  { name: "provider_credentials", orderBy: ["id"] },
  { name: "provider_services", orderBy: ["id"] },
  { name: "provider_availability", orderBy: ["id"] },
  { name: "patient_availability", orderBy: ["id"] },
  { name: "patient_preferences", orderBy: ["id"] },
  { name: "patient_restrictions", orderBy: ["id"] },
  { name: "resources", orderBy: ["id"] },
  { name: "service_resources", orderBy: ["id"] },
  { name: "appointments", orderBy: ["id"] },
  { name: "appointment_resources", orderBy: ["id"] },
  { name: "optimization_requests", orderBy: ["id"] },
  { name: "optimization_results", orderBy: ["id"] },
  { name: "optimization_changes", orderBy: ["id"] },
  { name: "audit_log", orderBy: ["id"] },
  { name: "user_profiles", orderBy: ["user_id"] },
  { name: "patient_care_team", orderBy: ["id"] },
  { name: "patient_contacts", orderBy: ["id"] },
  { name: "intake_tasks", orderBy: ["id"] },
  { name: "provider_supervision", orderBy: ["id"] },
  { name: "notifications", orderBy: ["id"] },
  { name: "push_subscriptions", orderBy: ["id"] },
  { name: "push_notification_deliveries", orderBy: ["id"] },
  { name: "schedule_disruptions", orderBy: ["id"] },
  { name: "recovery_cases", orderBy: ["id"] },
  { name: "recovery_offers", orderBy: ["id"] },
  { name: "recovery_idempotency", orderBy: ["actor_id", "operation", "idempotency_key"] },
  { name: "notification_receipts", orderBy: ["notification_id", "user_id"] },
  { name: "communication_destination_hash_keys", orderBy: ["singleton"] },
  { name: "communication_consents", orderBy: ["id"] },
  { name: "communication_consent_events", orderBy: ["id"] },
  { name: "communication_destination_suppressions", orderBy: ["channel", "destination_fingerprint"] },
  { name: "communication_jobs", orderBy: ["id"] },
  { name: "communication_delivery_attempts", orderBy: ["id"] },
  { name: "communication_delivery_receipts", orderBy: ["id"] },
  { name: "communication_idempotency", orderBy: ["actor_key", "operation", "idempotency_key"] },
  { name: "communication_delivery_config", orderBy: ["singleton"] },
  { name: "communication_receipt_tokens", orderBy: ["communication_job_id"] },
  { name: "optimization_plan_decisions", orderBy: ["id"] },
  { name: "appointment_reduction_requests", orderBy: ["id"] },
  { name: "provider_time_off_requests", orderBy: ["id"] },
  { name: "user_access_commands", orderBy: ["actor_id", "idempotency_key"] },
  { name: "operational_events", orderBy: ["id"] },
  { name: "guardian_portal_access", orderBy: ["id"] },
  { name: "guardian_portal_access_events", orderBy: ["id"] },
];

export function normalizeRecoveryUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("Recovery verification requires an HTTPS Supabase URL.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function recoveryManifestErrors(
  expected: RecoveryManifest,
  actual: RecoveryManifest,
) {
  const errors: string[] = [];
  if (expected.format_version !== RECOVERY_MANIFEST_VERSION) {
    errors.push("The source manifest format is unsupported.");
  }
  if (expected.schema_version !== REQUIRED_SCHEMA_VERSION) {
    errors.push("The source manifest schema is not at the required version.");
  }
  if (actual.schema_version !== REQUIRED_SCHEMA_VERSION) {
    errors.push("The restored schema is not at the required version.");
  }
  if (actual.source_host === expected.source_host) {
    errors.push("Verification must run against an isolated project, not the source project.");
  }

  const requiredNames = RECOVERY_TABLES.map(({ name }) => name).sort();
  const expectedNames = Object.keys(expected.tables).sort();
  const actualNames = Object.keys(actual.tables).sort();
  if (
    expectedNames.join("\n") !== requiredNames.join("\n") ||
    actualNames.join("\n") !== requiredNames.join("\n")
  ) {
    errors.push("The restored table inventory does not match the source manifest.");
  }

  for (const table of requiredNames) {
    const source = expected.tables[table];
    const restored = actual.tables[table];
    if (!source || !restored || source.rows !== restored.rows || source.hmac !== restored.hmac) {
      errors.push(`Restore integrity mismatch: ${table}.`);
    }
  }
  if (
    expected.auth_users.rows !== actual.auth_users.rows ||
    expected.auth_users.hmac !== actual.auth_users.hmac
  ) {
    errors.push("Restore integrity mismatch: authentication users.");
  }
  return errors;
}

export function assertRecoveryManifest(value: unknown): asserts value is RecoveryManifest {
  const isSummary = (summary: unknown): summary is RecoveryTableSummary => (
    typeof summary === "object" &&
    summary !== null &&
    "rows" in summary &&
    typeof summary.rows === "number" &&
    Number.isSafeInteger(summary.rows) &&
    summary.rows >= 0 &&
    "hmac" in summary &&
    typeof summary.hmac === "string" &&
    /^[a-f0-9]{64}$/.test(summary.hmac)
  );

  if (
    !value ||
    typeof value !== "object" ||
    !("format_version" in value) || typeof value.format_version !== "number" ||
    !("schema_version" in value) || typeof value.schema_version !== "string" ||
    !("source_host" in value) || typeof value.source_host !== "string" ||
    !("captured_at" in value) || typeof value.captured_at !== "string" ||
    !("tables" in value) || typeof value.tables !== "object" || value.tables === null ||
    !("auth_users" in value) || !isSummary(value.auth_users) ||
    !Object.values(value.tables).every(isSummary)
  ) {
    throw new Error("The recovery manifest is invalid.");
  }
}
