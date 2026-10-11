"use server";

import { redirect } from "next/navigation";
import { can } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

const back = (patientId: string, key: string, value: string) => `/patients/${patientId}/care-team?${key}=${encodeURIComponent(value)}`;

export async function addCareTeamMember(formData: FormData) {
  const patientId = String(formData.get("patient_id") ?? "");
  const providerId = String(formData.get("provider_id") ?? "");
  const relationship = String(formData.get("relationship") ?? "TREATING_PROVIDER");
  const start = String(formData.get("effective_start") ?? new Date().toISOString().slice(0, 10));
  const session = await getSession();
  if (!session || (!can(session.role, "schedule.book") && !can(session.role, "clinical.set_requirements"))) redirect("/no-access");
  if (!patientId || !providerId) redirect(back(patientId, "error", "Choose a clinician."));
  const supabase = await createClient();
  const { error } = await supabase.from("patient_care_team").insert({ patient_id: patientId, provider_id: providerId, relationship, effective_start: start, created_by: session.userId });
  if (error) redirect(back(patientId, "error", error.code === "23505" ? "That care-team assignment already exists." : error.message));
  redirect(back(patientId, "notice", "Care-team member added."));
}

export async function endCareTeamMember(formData: FormData) {
  const patientId = String(formData.get("patient_id") ?? "");
  const membershipId = String(formData.get("membership_id") ?? "");
  const session = await getSession();
  if (!session || (!can(session.role, "schedule.book") && !can(session.role, "clinical.set_requirements"))) redirect("/no-access");
  const supabase = await createClient();
  const { error } = await supabase.from("patient_care_team").update({ active: false, effective_end: new Date().toISOString().slice(0, 10) }).eq("id", membershipId).eq("patient_id", patientId);
  if (error) redirect(back(patientId, "error", error.message));
  redirect(back(patientId, "notice", "Care-team assignment ended."));
}
