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
    patients, services, serviceDurations, serviceResources, providers,
    providerServices, providerCredentials, providerAvailability,
    patientAvailability, patientRestrictions, patientPreferences,
    patientServiceRequirements, authorizations, locations, resources, appointments,
  ].find((result) => result.error);
  if (failed?.error) throw new Error(`Snapshot load failed: ${failed.error.message}`);

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
    appointments: appointments.data ?? [],
    appointmentResources: appointmentResources.data ?? [],
  };
}

export interface LoadedHorizon {
  ctx: ScheduleContext;
  /** True when the data came from the built-in scenario rather than Supabase. */
  synthetic: boolean;
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
    return { ctx: new ScheduleContext(grid, buildClinicRows()), synthetic: true };
  }

  const rows = await loadSnapshotRows(request);
  return { ctx: new ScheduleContext(grid, rows), synthetic: false };
}
