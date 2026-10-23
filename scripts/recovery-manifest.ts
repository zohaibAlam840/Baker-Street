import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { REQUIRED_SCHEMA_VERSION } from "../lib/deployment/verification";
import {
  RECOVERY_MANIFEST_VERSION,
  RECOVERY_TABLES,
  type RecoveryManifest,
  type RecoveryTableSpec,
  type RecoveryTableSummary,
  assertRecoveryManifest,
  normalizeRecoveryUrl,
  recoveryManifestErrors,
} from "../lib/recovery/restoreVerification";

const PAGE_SIZE = 500;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

async function summarizeTable(
  client: SupabaseClient,
  spec: RecoveryTableSpec,
  hmacKey: string,
): Promise<RecoveryTableSummary> {
  const hmac = createHmac("sha256", hmacKey);
  let rows = 0;

  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = client.from(spec.name).select("*");
    for (const column of spec.orderBy) query = query.order(column, { ascending: true });
    const result = await query.range(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw new Error(`Could not read recovery table ${spec.name}: ${result.error.code}`);
    const page = result.data ?? [];
    for (const row of page) hmac.update(canonicalJson(row)).update("\n");
    rows += page.length;
    if (page.length < PAGE_SIZE) break;
  }

  return { rows, hmac: hmac.digest("hex") };
}

async function summarizeAuthUsers(client: SupabaseClient, hmacKey: string) {
  const userDigests: string[] = [];
  for (let page = 1; ; page += 1) {
    const result = await client.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (result.error) {
      const code = "code" in result.error && typeof result.error.code === "string"
        ? result.error.code
        : "AUTH_USERS_READ_FAILED";
      throw new Error(`Could not read authentication users: ${code}`);
    }
    for (const user of result.data.users) {
      userDigests.push(createHmac("sha256", hmacKey).update(canonicalJson(user)).digest("hex"));
    }
    if (result.data.users.length < PAGE_SIZE) break;
  }
  const hmac = createHmac("sha256", hmacKey);
  for (const digest of userDigests.sort()) hmac.update(digest).update("\n");
  return { rows: userDigests.length, hmac: hmac.digest("hex") };
}

async function buildManifest(
  client: SupabaseClient,
  sourceHost: string,
  hmacKey: string,
): Promise<RecoveryManifest> {
  const schema = await client.rpc("app_schema_status");
  if (schema.error) throw new Error(`Could not verify the schema: ${schema.error.code}`);
  const status = schema.data as { ready?: boolean; version?: string } | null;
  if (status?.ready !== true || status.version !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(`The database must report ready at schema ${REQUIRED_SCHEMA_VERSION}.`);
  }

  const tables: Record<string, RecoveryTableSummary> = {};
  for (const spec of RECOVERY_TABLES) {
    tables[spec.name] = await summarizeTable(client, spec, hmacKey);
  }

  return {
    format_version: RECOVERY_MANIFEST_VERSION,
    schema_version: status.version,
    source_host: sourceHost,
    captured_at: new Date().toISOString(),
    tables,
    auth_users: await summarizeAuthUsers(client, hmacKey),
  };
}

async function main() {
  const command = process.argv[2];
  const manifestPath = process.argv[3];
  if (!manifestPath || !["capture", "verify"].includes(command)) {
    throw new Error("Usage: npm run recovery:manifest -- <capture|verify> <manifest-path>");
  }

  const rawUrl = process.env.RECOVERY_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.RECOVERY_SUPABASE_SERVICE_ROLE_KEY ?? "";
  const hmacKey = process.env.RECOVERY_MANIFEST_HMAC_KEY ?? "";
  if (!rawUrl || !serviceRoleKey) {
    throw new Error("Set RECOVERY_SUPABASE_URL and RECOVERY_SUPABASE_SERVICE_ROLE_KEY.");
  }
  if (hmacKey.length < 32) {
    throw new Error("RECOVERY_MANIFEST_HMAC_KEY must contain at least 32 characters.");
  }

  const url = normalizeRecoveryUrl(rawUrl);
  const client = createClient(url.href, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (command === "capture") {
    const manifest = await buildManifest(client, url.host, hmacKey);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Recovery manifest captured for ${Object.keys(manifest.tables).length} tables. Store it securely.`);
    return;
  }

  const expected: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  assertRecoveryManifest(expected);
  const actual = await buildManifest(client, url.host, hmacKey);
  const errors = recoveryManifestErrors(expected, actual);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.log(`Restore verified across ${Object.keys(actual.tables).length} tables and authentication users.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Recovery verification failed.");
  process.exit(1);
});
