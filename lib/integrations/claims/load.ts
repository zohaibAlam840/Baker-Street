import type { createClient } from "@/lib/supabase/server";
import { readClaimsConfig } from "./config";
import { buildClaimDraft, type ClaimDraft } from "./fhir";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export interface LoadedClaimDraft extends ClaimDraft {
  patientName: string;
  serviceName: string;
  startTime: string;
  payer: string | null;
}

export async function loadCompletedClaimDrafts(
  supabase: SupabaseClient,
  startDate: string,
  endDateExclusive: string,
): Promise<LoadedClaimDraft[]> {
  const appointmentResult = await supabase
    .from("appointments")
    .select("id,patient_id,provider_id,service_id,authorization_id,start_time,end_time")
    .eq("status", "COMPLETED")
    .gte("start_time", `${startDate}T00:00:00.000Z`)
    .lt("start_time", `${endDateExclusive}T00:00:00.000Z`)
    .order("start_time");
  if (appointmentResult.error) throw new Error("CLAIMS_APPOINTMENTS_UNAVAILABLE");
  const appointments = appointmentResult.data ?? [];
  if (appointments.length === 0) return [];
  const patientIds = [...new Set(appointments.map((row) => row.patient_id))];
  const providerIds = [...new Set(appointments.flatMap((row) => row.provider_id ? [row.provider_id] : []))];
  const serviceIds = [...new Set(appointments.map((row) => row.service_id))];
  const authorizationIds = [...new Set(appointments.flatMap((row) => row.authorization_id ? [row.authorization_id] : []))];
  const [patientResult, providerResult, serviceResult, authorizationResult] = await Promise.all([
    supabase.from("patients").select("id,external_id,first_name,last_name").in("id", patientIds),
    providerIds.length ? supabase.from("providers").select("id,external_id").in("id", providerIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("services").select("id,service_code,service_name").in("id", serviceIds),
    authorizationIds.length ? supabase.from("authorizations").select("id,payer,authorization_number").in("id", authorizationIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (patientResult.error || providerResult.error || serviceResult.error || authorizationResult.error) {
    throw new Error("CLAIMS_REFERENCE_DATA_UNAVAILABLE");
  }
  const patients = new Map((patientResult.data ?? []).map((row) => [row.id, row]));
  const providers = new Map((providerResult.data ?? []).map((row) => [row.id, row]));
  const services = new Map((serviceResult.data ?? []).map((row) => [row.id, row]));
  const authorizations = new Map((authorizationResult.data ?? []).map((row) => [row.id, row]));
  const config = readClaimsConfig();

  return appointments.map((appointment) => {
    const patient = patients.get(appointment.patient_id);
    const provider = appointment.provider_id ? providers.get(appointment.provider_id) : null;
    const service = services.get(appointment.service_id);
    const authorization = appointment.authorization_id ? authorizations.get(appointment.authorization_id) : null;
    const serviceCode = service?.service_code ?? appointment.service_id;
    const draft = buildClaimDraft({
      appointmentId: appointment.id,
      patientId: appointment.patient_id,
      patientExternalId: patient?.external_id ?? null,
      providerId: appointment.provider_id,
      providerExternalId: provider?.external_id ?? null,
      serviceCode,
      serviceName: service?.service_name ?? "Unknown service",
      billingCode: config.serviceCodes[serviceCode] ?? null,
      payer: authorization?.payer ?? null,
      authorizationReference: authorization?.authorization_number ?? null,
      // Diagnosis is deliberately absent until the client approves a clinical
      // source and mapping; the adapter will refuse live submission.
      diagnosisCode: null,
      startTime: appointment.start_time,
      endTime: appointment.end_time,
    });
    return {
      ...draft,
      patientName: patient ? `${patient.first_name} ${patient.last_name}` : "Patient unavailable",
      serviceName: service?.service_name ?? "Unknown service",
      startTime: appointment.start_time,
      payer: authorization?.payer ?? null,
    };
  });
}
