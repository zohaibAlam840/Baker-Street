/**
 * Seed Supabase with the acceptance scenario (spec sections 69-70).
 *
 *   npx tsx scripts/seed.ts
 *
 * The scenario is defined once, in lib/testing/scenario.ts, and this script
 * projects it into the database. Keeping a separate seed.sql would mean two
 * definitions of the same week drifting apart.
 *
 * The fixture uses readable ids ("prv-rbt-alice") while the schema uses uuid
 * columns, so every id is hashed into a stable UUID on the way in. The same
 * input always produces the same UUID, which makes re-seeding idempotent.
 */

import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { buildScenarioRows } from "../lib/testing/scenario";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before seeding.",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

/** Deterministic UUID from any string, in the v5 layout. */
function uuidFor(name: string): string {
  const h = createHash("sha1").update(`bsh:${name}`).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${variant}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/** Every column whose value is a reference to another fixture row. */
const ID_COLUMNS = new Set([
  "id",
  "patient_id",
  "service_id",
  "provider_id",
  "location_id",
  "resource_id",
  "authorization_id",
  "appointment_id",
  "primary_location_id",
  "home_location_id",
  "preferred_service_id",
  "preferred_provider_id",
  "preferred_location_id",
  "original_provider_id",
  "original_location_id",
  "service_allowed",
]);

function mapIds(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    out[column] =
      ID_COLUMNS.has(column) && typeof value === "string" ? uuidFor(value) : value;
  }
  return out;
}

async function insert(table: string, rows: readonly object[]) {
  if (rows.length === 0) return;
  const { error } = await supabase.from(table).upsert(rows.map(mapIds), {
    onConflict: "id",
  });
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`  ${table.padEnd(30)} ${rows.length}`);
}

async function main() {
  const rows = buildScenarioRows();

  console.log("Seeding the acceptance scenario:\n");

  // Insertion order follows the foreign keys.
  await insert("locations", rows.locations);
  await insert("services", rows.services);
  await insert("service_durations", rows.serviceDurations);
  await insert("resources", rows.resources);
  await insert("service_resources", rows.serviceResources);
  await insert("patients", rows.patients);
  await insert("providers", rows.providers);
  await insert("provider_credentials", rows.providerCredentials);
  await insert("provider_services", rows.providerServices);
  await insert("provider_availability", rows.providerAvailability);
  await insert("patient_availability", rows.patientAvailability);
  await insert("patient_restrictions", rows.patientRestrictions);
  await insert("patient_preferences", rows.patientPreferences);
  await insert("patient_service_requirements", rows.patientServiceRequirements);
  await insert("authorizations", rows.authorizations);
  await insert("appointments", rows.appointments);

  // Derive an explicit care team from the fixture's delivered care. RLS uses
  // these durable relationships, never appointment history, to define a
  // provider's caseload.
  const careTeam = new Map<string, { patient_id: string; provider_id: string }>();
  for (const appointment of rows.appointments) {
    if (!appointment.provider_id) continue;
    careTeam.set(`${appointment.patient_id}:${appointment.provider_id}`, {
      patient_id: uuidFor(appointment.patient_id),
      provider_id: uuidFor(appointment.provider_id),
    });
  }
  const careTeamRows = [...careTeam.values()].map((link) => ({
    id: uuidFor(`care-team:${link.patient_id}:${link.provider_id}`),
    ...link,
    relationship: "TREATING_PROVIDER",
    effective_start: rows.patientServiceRequirements[0]?.effective_start ?? "2026-01-01",
    active: true,
  }));
  if (careTeamRows.length) {
    const { error } = await supabase.from("patient_care_team").upsert(careTeamRows, { onConflict: "id" });
    if (error) throw new Error(`patient_care_team: ${error.message}`);
    console.log(`  ${"patient_care_team".padEnd(30)} ${careTeamRows.length}`);
  }

  // appointment_resources has no id column in the fixture.
  const appointmentResources = rows.appointmentResources.map((link) => ({
    id: uuidFor(`apt-res:${link.appointment_id}:${link.resource_id}`),
    appointment_id: uuidFor(link.appointment_id),
    resource_id: uuidFor(link.resource_id),
  }));
  if (appointmentResources.length > 0) {
    const { error } = await supabase
      .from("appointment_resources")
      .upsert(appointmentResources, { onConflict: "id" });
    if (error) throw new Error(`appointment_resources: ${error.message}`);
    console.log(`  ${"appointment_resources".padEnd(30)} ${appointmentResources.length}`);
  }

  console.log("\nDone. John Reyes:", uuidFor("pat-john"));
  console.log("ABA Direct:      ", uuidFor("svc-aba-direct"));
}

main().catch((error) => {
  console.error("\nSeed failed:", error.message);
  process.exit(1);
});
