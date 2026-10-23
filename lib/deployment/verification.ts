export const REQUIRED_SCHEMA_VERSION = "20261024010000";

export interface HealthBody {
  status?: string;
  auth?: string;
  database?: string;
  configuration?: string;
  schema_version?: string | null;
  release?: string;
}

export function healthErrors(
  status: number,
  body: HealthBody | null,
  expectedRelease?: string,
) {
  const errors: string[] = [];
  if (status < 200 || status >= 300) errors.push(`Health endpoint returned HTTP ${status}.`);
  if (body?.status !== "ok") errors.push("Health status is not ok.");
  if (body?.auth !== "available") errors.push("Supabase Auth is not available.");
  if (body?.database !== "available") errors.push("The database is not available.");
  if (body?.configuration !== "available") errors.push("The deployed environment contract is not valid.");
  if (body?.schema_version !== REQUIRED_SCHEMA_VERSION) {
    errors.push(`Schema version must be ${REQUIRED_SCHEMA_VERSION}.`);
  }
  if (expectedRelease) {
    const actual = body?.release ?? "";
    if (actual.length < 7 || !expectedRelease.toLowerCase().startsWith(actual.toLowerCase())) {
      errors.push("The deployed release does not match EXPECTED_RELEASE_SHA.");
    }
  }
  return errors;
}

export function securityHeaderErrors(headers: Headers, isHttps: boolean) {
  const errors: string[] = [];
  const exact: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-permitted-cross-domain-policies": "none",
  };
  for (const [name, expected] of Object.entries(exact)) {
    if (headers.get(name) !== expected) errors.push(`${name} must be ${expected}.`);
  }

  const permissions = headers.get("permissions-policy") ?? "";
  for (const directive of ["camera=()", "microphone=()", "geolocation=()", "browsing-topics=()"]) {
    if (!permissions.includes(directive)) errors.push(`Permissions-Policy is missing ${directive}.`);
  }

  const csp = headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ]) {
    if (!csp.includes(directive)) errors.push(`Content-Security-Policy is missing ${directive}.`);
  }

  if (isHttps && !headers.get("strict-transport-security")?.includes("max-age=")) {
    errors.push("Strict-Transport-Security is missing on the HTTPS deployment.");
  }
  if (headers.has("x-powered-by")) errors.push("x-powered-by must not disclose the framework.");
  return errors;
}

export function protectedRedirectErrors(
  base: URL,
  status: number,
  location: string | null,
  body = "",
) {
  const errors: string[] = [];
  let destinationValue = location;
  if (status === 200) {
    const streamedRedirect = body.match(
      /<meta[^>]+id="__next-page-redirect"[^>]+content="[^"]*url=([^";]+)[^"]*"/i,
    );
    destinationValue = streamedRedirect?.[1] ?? null;
    if (!destinationValue) {
      errors.push("Anonymous protected route did not contain a Next.js login redirect marker.");
    }
  } else if (![303, 307, 308].includes(status)) {
    errors.push(`Anonymous protected route returned unexpected HTTP ${status}.`);
  }
  if (!destinationValue) return errors;
  const destination = new URL(destinationValue, base);
  if (destination.origin !== base.origin || destination.pathname !== "/login") {
    errors.push("Anonymous protected route did not redirect to the same-origin login page.");
  }
  return errors;
}
