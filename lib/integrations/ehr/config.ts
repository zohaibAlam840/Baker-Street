export type FhirAuth =
  | { mode: "NONE" }
  | { mode: "BEARER"; token: string }
  | {
      mode: "OAUTH2_CLIENT_CREDENTIALS";
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    };

export interface EhrConfig {
  baseUrl: string;
  timeoutMs: number;
  auth: FhirAuth;
}

type Environment = Readonly<Record<string, string | undefined>>;

export class EhrConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhrConfigurationError";
  }
}

const value = (env: Environment, name: string) => env[name]?.trim() ?? "";

function httpsUrl(raw: string, name: string) {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new EhrConfigurationError(`${name} must be a valid HTTPS URL.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EhrConfigurationError(`${name} must be an HTTPS URL without credentials, query, or fragment.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function readEhrConfig(env: Environment = process.env): EhrConfig | null {
  const enabled = value(env, "EHR_INTEGRATION_ENABLED").toLowerCase();
  if (!enabled || enabled === "false") return null;
  if (enabled !== "true") throw new EhrConfigurationError("EHR_INTEGRATION_ENABLED must be true or false.");
  const baseUrl = httpsUrl(value(env, "EHR_FHIR_BASE_URL"), "EHR_FHIR_BASE_URL");
  const timeoutRaw = value(env, "EHR_FHIR_TIMEOUT_MS");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new EhrConfigurationError("EHR_FHIR_TIMEOUT_MS must be an integer between 500 and 30000.");
  }
  const mode = (value(env, "EHR_FHIR_AUTH_MODE") || "NONE").toUpperCase();
  let auth: FhirAuth;
  if (mode === "NONE") {
    auth = { mode: "NONE" };
  } else if (mode === "BEARER") {
    const token = value(env, "EHR_FHIR_BEARER_TOKEN");
    if (token.length < 16) throw new EhrConfigurationError("EHR_FHIR_BEARER_TOKEN must contain at least 16 characters.");
    auth = { mode: "BEARER", token };
  } else if (mode === "OAUTH2_CLIENT_CREDENTIALS") {
    const clientId = value(env, "EHR_FHIR_CLIENT_ID");
    const clientSecret = value(env, "EHR_FHIR_CLIENT_SECRET");
    if (!clientId || clientSecret.length < 16) {
      throw new EhrConfigurationError("FHIR OAuth requires a client ID and client secret of at least 16 characters.");
    }
    auth = {
      mode: "OAUTH2_CLIENT_CREDENTIALS",
      tokenUrl: httpsUrl(value(env, "EHR_FHIR_TOKEN_URL"), "EHR_FHIR_TOKEN_URL"),
      clientId,
      clientSecret,
      ...(value(env, "EHR_FHIR_SCOPE") ? { scope: value(env, "EHR_FHIR_SCOPE") } : {}),
    };
  } else {
    throw new EhrConfigurationError("EHR_FHIR_AUTH_MODE must be NONE, BEARER, or OAUTH2_CLIENT_CREDENTIALS.");
  }
  return { baseUrl, timeoutMs, auth };
}
