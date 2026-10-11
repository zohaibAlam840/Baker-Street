const REQUIRED_SCHEMA_VERSION = "20261011031200";

interface HealthBody {
  status?: string;
  auth?: string;
  database?: string;
  schema_version?: string | null;
  release?: string;
}

async function main() {
  const base = (process.env.DEPLOYMENT_URL ?? process.argv[2] ?? "").replace(/\/$/, "");
  if (!base) throw new Error("Set DEPLOYMENT_URL or pass the deployed URL.");

  const health = await fetch(`${base}/api/health`, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await health.json().catch(() => null)) as HealthBody | null;
  if (
    !health.ok ||
    body?.status !== "ok" ||
    body.auth !== "available" ||
    body.database !== "available" ||
    body.schema_version !== REQUIRED_SCHEMA_VERSION
  ) {
    throw new Error(`Health check failed: ${health.status} ${JSON.stringify(body)}`);
  }

  const page = await fetch(`${base}/login`, { signal: AbortSignal.timeout(10_000) });
  const required: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  for (const [name, expected] of Object.entries(required)) {
    if (page.headers.get(name) !== expected) {
      throw new Error(`Missing security header ${name}`);
    }
  }
  if (!page.ok) throw new Error(`Login page failed: ${page.status}`);

  console.log(
    JSON.stringify({
      ok: true,
      url: base,
      release: body.release,
      schema_version: body.schema_version,
      security_headers: true,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
