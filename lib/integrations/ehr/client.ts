import { readEhrConfig, type EhrConfig } from "./config";

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function authorization(config: EhrConfig) {
  if (config.auth.mode === "NONE") return null;
  if (config.auth.mode === "BEARER") return `Bearer ${config.auth.token}`;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return `Bearer ${cachedToken.value}`;
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (config.auth.scope) form.set("scope", config.auth.scope);
  const basic = Buffer.from(`${config.auth.clientId}:${config.auth.clientSecret}`).toString("base64");
  const response = await fetch(config.auth.tokenUrl, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`TOKEN_HTTP_${response.status}`);
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload.access_token !== "string" || payload.access_token.length < 16) {
    throw new Error("TOKEN_RESPONSE_INVALID");
  }
  const tokenType = typeof payload.token_type === "string" ? payload.token_type.toLowerCase() : "bearer";
  if (tokenType !== "bearer") throw new Error("TOKEN_TYPE_UNSUPPORTED");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? Math.max(60, Math.min(86_400, payload.expires_in))
    : 300;
  cachedToken = { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1_000 };
  return `Bearer ${payload.access_token}`;
}

export interface FhirCapability {
  fhirVersion: string;
  softwareName: string | null;
}

export async function fetchFhirCapability(): Promise<FhirCapability | null> {
  const config = readEhrConfig();
  if (!config) return null;
  const auth = await authorization(config);
  const response = await fetch(`${config.baseUrl}/metadata`, {
    cache: "no-store",
    headers: {
      accept: "application/fhir+json",
      ...(auth ? { authorization: auth } : {}),
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`FHIR_HTTP_${response.status}`);
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || payload.resourceType !== "CapabilityStatement" || typeof payload.fhirVersion !== "string") {
    throw new Error("FHIR_CAPABILITY_INVALID");
  }
  if (!payload.fhirVersion.startsWith("4.0") && !payload.fhirVersion.startsWith("4.3")) {
    throw new Error("FHIR_VERSION_UNSUPPORTED");
  }
  const software = payload.software;
  const softwareName = typeof software === "object" && software !== null && typeof (software as Record<string, unknown>).name === "string"
    ? String((software as Record<string, unknown>).name).slice(0, 120)
    : null;
  return { fhirVersion: payload.fhirVersion, softwareName };
}
