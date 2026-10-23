import { NextResponse } from "next/server";

import { authorizeApi, isApiError } from "@/lib/auth/api";
import { buildPatientFhirBundle } from "@/lib/integrations/ehr/fhir";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ patientId: string }> }) {
  const auth = await authorizeApi("view.patient_schedule");
  if (isApiError(auth)) return auth;
  const { patientId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) {
    return NextResponse.json({ error: "Patient not found." }, { status: 404 });
  }
  const supabase = await createClient();
  const patientResult = await supabase
    .from("patients")
    .select("id,external_id,first_name,last_name,date_of_birth,status")
    .eq("id", patientId)
    .maybeSingle();
  if (patientResult.error || !patientResult.data) {
    return NextResponse.json({ error: "Patient not found." }, { status: 404 });
  }
  const [authorizationResult, appointmentResult] = await Promise.all([
    supabase.from("authorizations").select("id,service_id,payer,authorization_number,authorized_hours,authorized_units,units_per_hour,start_date,end_date,status").eq("patient_id", patientId).order("start_date"),
    supabase.from("appointments").select("id,service_id,provider_id,location_id,start_time,end_time,status,telehealth").eq("patient_id", patientId).order("start_time"),
  ]);
  if (authorizationResult.error || appointmentResult.error) {
    return NextResponse.json({ error: "FHIR export could not be generated." }, { status: 500 });
  }
  const authorizations = authorizationResult.data ?? [];
  const appointments = appointmentResult.data ?? [];
  const serviceIds = [...new Set([...authorizations, ...appointments].map((row) => row.service_id))];
  const providerIds = [...new Set(appointments.flatMap((row) => row.provider_id ? [row.provider_id] : []))];
  const locationIds = [...new Set(appointments.flatMap((row) => row.location_id ? [row.location_id] : []))];
  const [serviceResult, providerResult, locationResult] = await Promise.all([
    serviceIds.length ? supabase.from("services").select("id,service_code,service_name").in("id", serviceIds) : Promise.resolve({ data: [], error: null }),
    providerIds.length ? supabase.from("providers").select("id,first_name,last_name").in("id", providerIds) : Promise.resolve({ data: [], error: null }),
    locationIds.length ? supabase.from("locations").select("id,name").in("id", locationIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (serviceResult.error || providerResult.error || locationResult.error) {
    return NextResponse.json({ error: "FHIR export could not be generated." }, { status: 500 });
  }
  const bundle = buildPatientFhirBundle({
    patient: patientResult.data,
    authorizations,
    appointments,
    services: serviceResult.data ?? [],
    providers: providerResult.data ?? [],
    locations: locationResult.data ?? [],
  });
  return NextResponse.json(bundle, {
    headers: {
      "content-type": "application/fhir+json; charset=utf-8",
      "content-disposition": `attachment; filename="patient-${patientId}.fhir.json"`,
      "cache-control": "private, no-store",
    },
  });
}
