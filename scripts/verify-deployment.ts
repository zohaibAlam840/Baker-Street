import {
  type HealthBody,
  healthErrors,
  protectedRedirectErrors,
  securityHeaderErrors,
} from "../lib/deployment/verification";

async function main() {
  const rawBase = process.env.DEPLOYMENT_URL ?? process.argv[2] ?? "";
  if (!rawBase) throw new Error("Set DEPLOYMENT_URL or pass the deployed URL.");

  const base = new URL(rawBase);
  if (base.protocol !== "https:" && process.env.VERIFY_ALLOW_HTTP !== "true") {
    throw new Error("Deployment verification requires HTTPS. Set VERIFY_ALLOW_HTTP=true only for a local check.");
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const requestHeaders = bypass
    ? { "x-vercel-protection-bypass": bypass }
    : undefined;

  const health = await fetch(new URL("/api/health", base), {
    headers: requestHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await health.json().catch(() => null)) as HealthBody | null;
  const errors = healthErrors(
    health.status,
    body,
    process.env.EXPECTED_RELEASE_SHA,
  );
  if (!health.headers.get("content-type")?.includes("application/json")) {
    errors.push("Health endpoint did not return JSON.");
  }
  if (!health.headers.get("cache-control")?.includes("no-store")) {
    errors.push("Health endpoint must use Cache-Control: no-store.");
  }

  const login = await fetch(new URL("/login", base), {
    headers: requestHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!login.ok) errors.push(`Login page returned HTTP ${login.status}.`);
  if (!login.headers.get("content-type")?.includes("text/html")) {
    errors.push("Login page did not return HTML.");
  }
  errors.push(...securityHeaderErrors(login.headers, base.protocol === "https:"));
  const loginText = await login.text();
  if (!loginText.includes("Baker Street") || !loginText.includes("Welcome back")) {
    errors.push("Login page did not contain the expected application shell.");
  }

  const protectedPage = await fetch(new URL("/dashboard", base), {
    headers: requestHeaders,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const protectedBody = await protectedPage.text();
  errors.push(...protectedRedirectErrors(
    base,
    protectedPage.status,
    protectedPage.headers.get("location"),
    protectedBody,
  ));

  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({
    ok: true,
    url: base.origin,
    release: body?.release,
    schema_version: body?.schema_version,
    checks: ["health", "schema", "release", "security_headers", "anonymous_redirect"],
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
