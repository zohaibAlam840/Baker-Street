export interface BillingCodeMapping {
  system: string;
  code: string;
  display?: string;
}

export interface ClaimsConfig {
  serviceCodes: Record<string, BillingCodeMapping>;
  submission: null | { url: string; token: string; timeoutMs: number };
}

type Environment = Readonly<Record<string, string | undefined>>;
const value = (env: Environment, name: string) => env[name]?.trim() ?? "";

export class ClaimsConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ClaimsConfigurationError"; }
}

function mappings(raw: string): Record<string, BillingCodeMapping> {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ClaimsConfigurationError("CLAIMS_SERVICE_CODE_MAP_JSON must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 500) {
    throw new ClaimsConfigurationError("CLAIMS_SERVICE_CODE_MAP_JSON must be an object with at most 500 entries.");
  }
  const out: Record<string, BillingCodeMapping> = {};
  for (const [serviceCode, candidate] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(serviceCode) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ClaimsConfigurationError("Claims service-code mappings contain an invalid entry.");
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.system !== "string" || !/^(https?:\/\/|urn:)[^\s]{1,240}$/.test(entry.system) || typeof entry.code !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(entry.code)) {
      throw new ClaimsConfigurationError("Every claims service mapping requires a safe code system and code.");
    }
    if (entry.display != null && (typeof entry.display !== "string" || entry.display.length > 120 || /[\r\n\t]/.test(entry.display))) {
      throw new ClaimsConfigurationError("Claims service mapping displays must contain at most 120 plain-text characters.");
    }
    out[serviceCode] = { system: entry.system, code: entry.code, ...(entry.display ? { display: entry.display } : {}) };
  }
  return out;
}

export function readClaimsConfig(env: Environment = process.env): ClaimsConfig {
  const serviceCodes = mappings(value(env, "CLAIMS_SERVICE_CODE_MAP_JSON"));
  const enabled = value(env, "CLAIMS_SUBMISSION_ENABLED").toLowerCase() || "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new ClaimsConfigurationError("CLAIMS_SUBMISSION_ENABLED must be true or false.");
  }
  if (enabled === "false") return { serviceCodes, submission: null };
  let url: URL;
  try { url = new URL(value(env, "CLAIMS_FHIR_SUBMISSION_URL")); } catch { throw new ClaimsConfigurationError("CLAIMS_FHIR_SUBMISSION_URL must be a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ClaimsConfigurationError("CLAIMS_FHIR_SUBMISSION_URL must be an HTTPS URL without credentials, query, or fragment.");
  }
  const token = value(env, "CLAIMS_FHIR_BEARER_TOKEN");
  if (token.length < 24) throw new ClaimsConfigurationError("CLAIMS_FHIR_BEARER_TOKEN must contain at least 24 characters.");
  const timeoutMs = Number(value(env, "CLAIMS_SUBMISSION_TIMEOUT_MS") || 10_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new ClaimsConfigurationError("CLAIMS_SUBMISSION_TIMEOUT_MS must be an integer between 500 and 30000.");
  }
  return { serviceCodes, submission: { url: url.toString(), token, timeoutMs } };
}
