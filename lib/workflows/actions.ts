"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can, type Permission } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const nullable = (form: FormData, key: string) => value(form, key) || null;
const numberOrNull = (form: FormData, key: string) => {
  const raw = value(form, key);
  return raw === "" ? null : Number(raw);
};
const checked = (form: FormData, key: string) => form.get(key) === "on";
const fail = (path: string, message: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
const done = (path: string, message: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(message)}`);

async function authorized(permission: Permission) {
  const session = await requireSession();
  if (!can(session.role, permission)) fail("/no-access", "You do not have permission for this action.");
  return { session, supabase: await createClient() };
}

function explainDatabaseError(message: string) {
  if (message.includes("appointments_patient_no_overlap")) return "The patient already has an appointment during that time.";
  if (message.includes("appointments_provider_no_overlap")) return "The clinician already has an appointment during that time.";
  if (message.includes("Authorization")) return message;
  if (message.includes("telehealth") || message.includes("in-person")) return message;
  return message;
}

export async function createAppointment(form: FormData) {
  const { session, supabase } = await authorized("schedule.book");
  const returnPath = "/appointments/new";
  const start = new Date(value(form, "start_time"));
  const duration = Number(value(form, "duration_minutes"));
  const repeats = Math.min(52, Math.max(1, Number(value(form, "repeat_count") || 1)));
  if (!Number.isFinite(start.getTime()) || !Number.isInteger(duration) || duration < 15 || duration % 15 !== 0) fail(returnPath, "Choose a valid start time and a duration in 15-minute increments.");
  const recurrence = repeats > 1 ? crypto.randomUUID() : null;
  const base = {
    patient_id: value(form, "patient_id"), service_id: value(form, "service_id"),
    provider_id: nullable(form, "provider_id"), location_id: nullable(form, "location_id"),
    authorization_id: nullable(form, "authorization_id"), telehealth: checked(form, "telehealth"),
    scheduling_flexibility: value(form, "scheduling_flexibility") || "FLEXIBLE",
    status: "SCHEDULED", notes: nullable(form, "notes"), recurrence_group_id: recurrence,
    created_by: session.userId,
  };
  if (!base.patient_id || !base.service_id || !base.provider_id) fail(returnPath, "Patient, service, and clinician are required.");
  const rows = Array.from({ length: repeats }, (_, index) => {
    const occurrenceStart = new Date(start); occurrenceStart.setUTCDate(occurrenceStart.getUTCDate() + index * 7);
    return { ...base, start_time: occurrenceStart.toISOString(), end_time: new Date(occurrenceStart.getTime() + duration * 60_000).toISOString() };
  });
  const { data, error } = await supabase.from("appointments").insert(rows).select("id");
  if (error) fail(returnPath, explainDatabaseError(error.message));
  revalidatePath("/schedule"); revalidatePath("/dashboard");
  done(`/appointments/${data![0].id}`, repeats > 1 ? `${repeats} recurring appointments booked.` : "Appointment booked.");
}

export async function updateAppointment(form: FormData) {
  const { supabase } = await authorized("schedule.book");
  const id = value(form, "appointment_id"); const path = `/appointments/${id}`;
  const start = new Date(value(form, "start_time")); const end = new Date(value(form, "end_time"));
  if (!id || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) fail(path, "Choose a valid start and end time.");
  const { error } = await supabase.from("appointments").update({
    provider_id: nullable(form, "provider_id"), location_id: nullable(form, "location_id"),
    start_time: start.toISOString(), end_time: end.toISOString(), status: value(form, "status"),
    scheduling_flexibility: value(form, "scheduling_flexibility"), notes: nullable(form, "reason"),
  }).eq("id", id);
  if (error) fail(path, explainDatabaseError(error.message));
  revalidatePath(path); revalidatePath("/schedule"); done(path, "Appointment updated and audited.");
}

export async function cancelAppointment(form: FormData) {
  const { supabase } = await authorized("schedule.book");
  const id=value(form,"appointment_id"), reason=value(form,"reason"), path=`/appointments/${id}`;
  if (reason.length < 3) fail(path, "Enter a cancellation reason.");
  const { error } = await supabase.from("appointments").update({ status:"CANCELLED", cancellation_reason:reason }).eq("id",id);
  if (error) fail(path,error.message); revalidatePath("/schedule"); done(path,"Appointment cancelled. Its history is preserved.");
}

export async function restoreAppointment(form: FormData) {
  const { supabase } = await authorized("schedule.book"); const id=value(form,"appointment_id"), path=`/appointments/${id}`;
  const { error }=await supabase.from("appointments").update({status:"SCHEDULED",cancellation_reason:null}).eq("id",id);
  if(error) fail(path,explainDatabaseError(error.message)); revalidatePath("/schedule"); done(path,"Appointment restored.");
}

export async function updateClinicalRequirement(form: FormData) {
  const { supabase }=await authorized("clinical.set_requirements"); const id=value(form,"requirement_id"), path=`/clinical/${id}`;
  const min=numberOrNull(form,"minimum_hours"), target=numberOrNull(form,"target_hours"), max=numberOrNull(form,"maximum_hours");
  if ([min,target,max].some(n=>n!==null && (n!<0 || n!>168)) || (min!==null&&max!==null&&min>max) || (target!==null&&min!==null&&target<min) || (target!==null&&max!==null&&target>max)) fail(path,"Hours must follow minimum ≤ target ≤ maximum.");
  if(value(form,"reason").length<5) fail(path,"Document the clinical reason for this change.");
  const {error}=await supabase.from("patient_service_requirements").update({minimum_hours_per_week:min,target_hours_per_week:target,maximum_hours_per_week:max,minimum_sessions_per_week:numberOrNull(form,"minimum_sessions"),target_sessions_per_week:numberOrNull(form,"target_sessions"),maximum_sessions_per_week:numberOrNull(form,"maximum_sessions"),priority:Number(value(form,"priority")||100),effective_start:value(form,"effective_start"),effective_end:nullable(form,"effective_end"),required:checked(form,"required")}).eq("id",id);
  if(error) fail(path,error.message); revalidatePath("/clinical"); done(path,"Clinical requirement saved and audited.");
}

export async function updateAuthorization(form: FormData) {
  const { supabase }=await authorized("authorization.manage"); const id=value(form,"authorization_id"), path=`/authorizations/${id}`;
  const start=value(form,"start_date"), end=value(form,"end_date"); if(!start||!end||start>end) fail(path,"Authorization dates are invalid.");
  const hours=numberOrNull(form,"authorized_hours"); if(hours!==null&&hours<0) fail(path,"Authorized hours cannot be negative.");
  const {error}=await supabase.from("authorizations").update({payer:nullable(form,"payer"),authorization_number:nullable(form,"authorization_number"),authorized_hours:hours,units_per_hour:Number(value(form,"units_per_hour")||4),start_date:start,end_date:end,status:value(form,"status")}).eq("id",id);
  if(error) fail(path,error.message); revalidatePath("/authorizations"); done(path,"Authorization saved and audited.");
}

export async function createAuthorization(form: FormData) {
  const {supabase}=await authorized("authorization.manage"); const path="/authorizations/new", start=value(form,"start_date"),end=value(form,"end_date");
  if(!start||!end||start>end) fail(path,"Authorization dates are invalid.");
  const {data,error}=await supabase.from("authorizations").insert({patient_id:value(form,"patient_id"),service_id:value(form,"service_id"),payer:nullable(form,"payer"),authorization_number:nullable(form,"authorization_number"),authorized_hours:numberOrNull(form,"authorized_hours"),units_per_hour:Number(value(form,"units_per_hour")||4),start_date:start,end_date:end,status:value(form,"status")||"ACTIVE"}).select("id").single();
  if(error||!data) fail(path,error?.message??"Authorization could not be created."); revalidatePath("/authorizations"); done(`/authorizations/${data!.id}`,"Authorization created and audited.");
}

export async function createClinicalRequirement(form: FormData) {
  const {supabase}=await authorized("clinical.set_requirements"); const path="/clinical/new";
  const min=numberOrNull(form,"minimum_hours"),target=numberOrNull(form,"target_hours"),max=numberOrNull(form,"maximum_hours");
  if(min!==null&&max!==null&&min>max) fail(path,"Minimum hours cannot exceed maximum hours.");
  const {data,error}=await supabase.from("patient_service_requirements").insert({patient_id:value(form,"patient_id"),service_id:value(form,"service_id"),minimum_hours_per_week:min,target_hours_per_week:target,maximum_hours_per_week:max,minimum_sessions_per_week:numberOrNull(form,"minimum_sessions"),target_sessions_per_week:numberOrNull(form,"target_sessions"),maximum_sessions_per_week:numberOrNull(form,"maximum_sessions"),required:checked(form,"required"),effective_start:value(form,"effective_start")||new Date().toISOString().slice(0,10)}).select("id").single();
  if(error||!data) fail(path,error?.message??"Requirement could not be created.");revalidatePath("/clinical");done(`/clinical/${data!.id}`,"Clinical requirement created and audited.");
}

export async function createPatient(form: FormData) {
  const { supabase }=await authorized("schedule.book"); const path="/patients/new";
  const first=value(form,"first_name"), last=value(form,"last_name"); if(!first||!last) fail(path,"First and last name are required.");
  const {data,error}=await supabase.from("patients").insert({first_name:first,last_name:last,external_id:nullable(form,"external_id"),date_of_birth:nullable(form,"date_of_birth"),status:value(form,"status")||"PENDING",primary_location_id:nullable(form,"primary_location_id"),timezone:value(form,"timezone")||"America/New_York"}).select("id").single();
  if(error||!data) fail(path,error?.message??"Patient could not be created."); revalidatePath("/patients"); done(`/patients/${data!.id}`,"Patient created. Complete the intake checklist next.");
}

export async function createProvider(form: FormData) {
  const { supabase }=await authorized("credentials.manage"); const path="/providers/new";
  const {data,error}=await supabase.from("providers").insert({first_name:value(form,"first_name"),last_name:value(form,"last_name"),external_id:nullable(form,"external_id"),provider_type:value(form,"provider_type"),status:value(form,"status")||"ACTIVE",home_location_id:nullable(form,"home_location_id"),timezone:value(form,"timezone")||"America/New_York"}).select("id").single();
  if(error||!data) fail(path,error?.message??"Clinician could not be created.");
  const credential=value(form,"credential_type"); if(credential){const result=await supabase.from("provider_credentials").insert({provider_id:data!.id,credential_type:credential,expiration_date:nullable(form,"credential_expiration"),status:"ACTIVE"});if(result.error) fail(`/providers/${data!.id}`,result.error.message);}
  revalidatePath("/providers"); done(`/providers/${data!.id}`,"Clinician created and audited.");
}

export async function addPatientContact(form:FormData){const{supabase}=await authorized("schedule.book");const patient=value(form,"patient_id"),path=`/patients/${patient}`;const name=value(form,"name");if(!name)fail(path,"Contact name is required.");const{error}=await supabase.from("patient_contacts").insert({patient_id:patient,name,relationship:value(form,"relationship")||"Caregiver",phone:nullable(form,"phone"),email:nullable(form,"email"),is_primary:checked(form,"is_primary"),authorized_to_receive_information:checked(form,"authorized")});if(error)fail(path,error.message);revalidatePath(path);done(path,"Contact added.");}

export async function addProviderCredential(form:FormData){const{supabase}=await authorized("credentials.manage");const provider=value(form,"provider_id"),path=`/providers/${provider}`;const credential=value(form,"credential_type");if(!credential)fail(path,"Credential type is required.");const{error}=await supabase.from("provider_credentials").insert({provider_id:provider,credential_type:credential,credential_number:nullable(form,"credential_number"),state:nullable(form,"state"),issue_date:nullable(form,"issue_date"),expiration_date:nullable(form,"expiration_date"),status:value(form,"status")||"ACTIVE"});if(error)fail(path,error.message);revalidatePath(path);done(path,"Credential added and audited.");}

export async function addSupervisionRelationship(form:FormData){const{supabase}=await authorized("credentials.manage");const supervisee=value(form,"supervisee_id"),path=`/providers/${supervisee}`,supervisor=value(form,"supervisor_id");if(!supervisor||supervisor===supervisee)fail(path,"Choose a different supervisor.");const{error}=await supabase.from("provider_supervision").insert({supervisor_id:supervisor,supervisee_id:supervisee,effective_start:value(form,"effective_start")||new Date().toISOString().slice(0,10)});if(error)fail(path,error.code==="23505"?"This supervision relationship is already active.":error.message);revalidatePath(path);done(path,"Supervisor assigned.");}

export async function toggleIntakeTask(form: FormData) {
  const {session,supabase}=await authorized("schedule.book"); const id=value(form,"task_id"), patient=value(form,"patient_id"), complete=value(form,"complete")==="true";
  const {error}=await supabase.from("intake_tasks").update({completed:complete,completed_at:complete?new Date().toISOString():null,completed_by:complete?session.userId:null}).eq("id",id);
  if(error) fail(`/patients/${patient}`,error.message); revalidatePath(`/patients/${patient}`); done(`/patients/${patient}`,complete?"Intake task completed.":"Intake task reopened.");
}

export async function markNotificationRead(form: FormData) {
  await requireSession(); const supabase=await createClient(); const id=value(form,"notification_id");
  await supabase.from("notifications").update({read_at:new Date().toISOString()}).eq("id",id); revalidatePath("/notifications");
}
