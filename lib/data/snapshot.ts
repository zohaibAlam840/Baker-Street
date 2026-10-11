/**
 * Loading a scheduling horizon out of Supabase.
 *
 * One batched read per horizon, then everything else happens in memory. The
 * rule engine must never issue a query mid-evaluation: candidate generation
 * will call it thousands of times per optimization run.
 */

import { SlotGrid } from "../domain/slots";
import { ScheduleContext, SnapshotRows } from "../rules/context";
import { buildClinicRows } from "../testing/clinic";
import { createClient } from "../supabase/server";

export interface HorizonRequest {
  /** YYYY-MM-DD, local to `timeZone`. */
  startDate: string;
  dayCount?: number;
  timeZone?: string;
  /** Narrow the load to one patient's world. Omit for a whole-clinic view. */
  patientId?: string;
  /** Add PHI-free busy intervals hidden by caseload RLS for conflict checks. */
  includeOpaqueBusy?: boolean;
}

const DEFAULT_TIMEZONE = process.env.SCHEDULING_TIMEZONE ?? "America/New_York";

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.USE_SYNTHETIC_DATA !== "true" &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}

/**
 * Load every row the rules could need for one horizon.
 *
 * Availability, restrictions and preferences are recurring weekly rules rather
 * than dated rows, so they are fetched whole and filtered by effective date in
 * `ScheduleContext`.
 */
export async function loadSnapshotRows(request: HorizonRequest): Promise<SnapshotRows> {
  // This client carries the signed-in user's cookies. Every query is filtered
  // by Postgres RLS; ordinary page reads never use the service-role key.
  const supabase = await createClient();
  const timeZone = request.timeZone ?? DEFAULT_TIMEZONE;
  const grid = new SlotGrid(request.startDate, request.dayCount ?? 7, timeZone);

  const windowStart = grid.dayStart(0).toISOString();
  const windowEnd = grid.horizonEnd().toISOString();

  const all = <T>(table: string) => supabase.from(table).select("*").returns<T[]>();

  // Appointments are the only table filtered by time; everything else is
  // configuration small enough to load whole at this stage.
  //
  // Deliberately NOT filtered by patient even for a patient-scoped run: the
  // provider-overlap and resource-capacity rules need every booking in the
  // window, including other patients', or they will happily double-book an RBT.
  const appointmentsQuery = supabase
    .from("appointments")
    .select("*")
    .lt("start_time", windowEnd)
    .gt("end_time", windowStart);

  const [
    patients,
    services,
    serviceDurations,
    serviceResources,
    providers,
    providerServices,
    providerCredentials,
    providerAvailability,
    patientAvailability,
    patientRestrictions,
    patientPreferences,
    patientServiceRequirements,
    authorizations,
    locations,
    resources,
    appointments,
  ] = await Promise.all([
    all<SnapshotRows["patients"][number]>("patients"),
    all<SnapshotRows["services"][number]>("services"),
    all<SnapshotRows["serviceDurations"][number]>("service_durations"),
    all<SnapshotRows["serviceResources"][number]>("service_resources"),
    all<SnapshotRows["providers"][number]>("providers"),
    all<SnapshotRows["providerServices"][number]>("provider_services"),
    all<SnapshotRows["providerCredentials"][number]>("provider_credentials"),
    all<SnapshotRows["providerAvailability"][number]>("provider_availability"),
    all<SnapshotRows["patientAvailability"][number]>("patient_availability"),
    all<SnapshotRows["patientRestrictions"][number]>("patient_restrictions"),
    all<SnapshotRows["patientPreferences"][number]>("patient_preferences"),
    all<SnapshotRows["patientServiceRequirements"][number]>("patient_service_requirements"),
    all<SnapshotRows["authorizations"][number]>("authorizations"),
    all<SnapshotRows["locations"][number]>("locations"),
    all<SnapshotRows["resources"][number]>("resources"),
    appointmentsQuery.returns<SnapshotRows["appointments"]>(),
  ]);

  const failed = [
    ["patients", patients], ["services", services],
    ["service_durations", serviceDurations], ["service_resources", serviceResources],
    ["providers", providers], ["provider_services", providerServices],
    ["provider_credentials", providerCredentials], ["provider_availability", providerAvailability],
    ["patient_availability", patientAvailability], ["patient_restrictions", patientRestrictions],
    ["patient_preferences", patientPreferences],
    ["patient_service_requirements", patientServiceRequirements],
    ["authorizations", authorizations], ["locations", locations],
    ["resources", resources], ["appointments", appointments],
  ] as const;
  const failedQuery = failed.find(([, result]) => result.error);
  if (failedQuery?.[1].error) {
    throw new Error(`Snapshot load failed for ${failedQuery[0]}: ${failedQuery[1].error.message}`);
  }

  const appointmentIds = (appointments.data ?? []).map((a) => a.id);
  const appointmentResources = appointmentIds.length
    ? await supabase
        .from("appointment_resources")
        .select("appointment_id, resource_id")
        .in("appointment_id", appointmentIds)
    : { data: [], error: null };
  if (appointmentResources.error) {
    throw new Error(`Snapshot load failed: ${appointmentResources.error.message}`);
  }

  type OpaqueBusyRow = {
    opaque_id: string;
    service_id: string;
    provider_id: string | null;
    location_id: string | null;
    start_time: string;
    end_time: string;
    telehealth: boolean;
    resource_ids: string[] | null;
  };
  const opaqueBusy = request.includeOpaqueBusy
    ? await supabase.rpc("optimization_busy_intervals", {
        p_start: windowStart,
        p_end: windowEnd,
      })
    : { data: [] as OpaqueBusyRow[], error: null };
  if (opaqueBusy.error) {
    throw new Error(`Snapshot busy-interval load failed: ${opaqueBusy.error.message}`);
  }
  const opaqueRows = (opaqueBusy.data ?? []) as OpaqueBusyRow[];
  const opaqueAppointments: SnapshotRows["appointments"] = opaqueRows.map((row) => ({
    id: row.opaque_id,
    patient_id: "00000000-0000-0000-0000-000000000000",
    service_id: row.service_id,
    provider_id: row.provider_id,
    authorization_id: null,
    location_id: row.location_id,
    start_time: row.start_time,
    end_time: row.end_time,
    status: "SCHEDULED",
    scheduling_flexibility: "LOCKED",
    telehealth: row.telehealth,
    original_start_time: null,
    original_provider_id: null,
    original_location_id: null,
  }));
  const opaqueResources = opaqueRows.flatMap((row) =>
    (row.resource_ids ?? []).map((resource_id) => ({
      appointment_id: row.opaque_id,
      resource_id,
    })),
  );

  return {
    patients: patients.data ?? [],
    services: services.data ?? [],
    serviceDurations: serviceDurations.data ?? [],
    serviceResources: serviceResources.data ?? [],
    providers: providers.data ?? [],
    providerServices: providerServices.data ?? [],
    providerCredentials: providerCredentials.data ?? [],
    providerAvailability: providerAvailability.data ?? [],
    patientAvailability: patientAvailability.data ?? [],
    patientRestrictions: patientRestrictions.data ?? [],
    patientPreferences: patientPreferences.data ?? [],
    patientServiceRequirements: patientServiceRequirements.data ?? [],
    authorizations: authorizations.data ?? [],
    locations: locations.data ?? [],
    resources: resources.data ?? [],
    appointments: [...(appointments.data ?? []), ...opaqueAppointments],
    appointmentResources: [...(appointmentResources.data ?? []), ...opaqueResources],
  };
}

export interface LoadedHorizon {
  ctx: ScheduleContext;
  /** True when the data came from the built-in scenario rather than Supabase. */
  synthetic: boolean;
}

/**
 * Build the intentionally synthetic clinic used by the public product tour.
 *
 * Public pages must not depend on the visitor's database permissions. A valid
 * Supabase cookie without an approved profile (for example, just after sign-up
 * or after an account is disabled) correctly sees no clinical rows through
 * RLS. Keeping the tour on the fixture makes `/` safe for every authentication
 * state and prevents it from becoming an accidental patient-data read.
 */
export function loadPublicDemoHorizon(request: HorizonRequest): LoadedHorizon {
  const timeZone = request.timeZone ?? DEFAULT_TIMEZONE;
  const grid = new SlotGrid(request.startDate, request.dayCount ?? 7, timeZone);
  return { ctx: new ScheduleContext(grid, buildClinicRows()), synthetic: true };
}

/**
 * Load a horizon, falling back to the built-in acceptance scenario when no
 * Supabase project is configured. The fallback is what makes the endpoints
 * runnable on a fresh clone; every response says which source it used so a
 * demo is never mistaken for real data.
 */
export async function loadHorizon(request: HorizonRequest): Promise<LoadedHorizon> {
  const timeZone = request.timeZone ?? DEFAULT_TIMEZONE;
  const grid = new SlotGrid(request.startDate, request.dayCount ?? 7, timeZone);

  if (process.env.USE_SYNTHETIC_DATA === "true" || !isSupabaseConfigured()) {
    return loadPublicDemoHorizon(request);
  }

  const rows = await loadSnapshotRows(request);
  return { ctx: new ScheduleContext(grid, rows), synthetic: false };
}
