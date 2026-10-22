"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { reconcileAppointmentReminders } from "@/lib/communications/reconcile";
import { loadHorizon } from "@/lib/data/snapshot";
import { startOfWeek } from "@/lib/domain/time";
import { evaluateBooking } from "@/lib/rules/engine";
import { FlatTravelModel } from "@/lib/rules/travel";
import { createClient } from "@/lib/supabase/server";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function destination(key: "error" | "notice", message: string) {
  return `/reductions?${new URLSearchParams({ [key]: message }).toString()}`;
}

function databaseMessage(message: string) {
  if (message.includes("changed; refresh")) return "This request changed while you were reviewing it. Refresh and review the current decision.";
  if (message.includes("already decided")) return "This request was already decided. Refresh to see its current status.";
  if (message.includes("outside your permitted caseload")) return "This patient is outside your current clinical caseload.";
  return message;
}

interface ReductionProposal {
  appointment_id: string;
  proposed_provider_id: string | null;
  proposed_location_id: string | null;
  proposed_start_time: string;
  proposed_end_time: string;
  proposed_resource_ids: unknown;
  patients: { timezone: string | null } | { timezone: string | null }[];
  appointments: {
    patient_id: string;
    service_id: string;
    authorization_id: string | null;
    telehealth: boolean;
  } | {
    patient_id: string;
    service_id: string;
    authorization_id: string | null;
    telehealth: boolean;
  }[];
}

function one<T>(relation: T | T[]): T | null {
  return Array.isArray(relation) ? relation[0] ?? null : relation;
}

export async function decideAppointmentReduction(form: FormData) {
  await requirePermission("schedule.approve_reduction");
  const requestId = value(form, "request_id");
  const expectedVersion = Number(value(form, "expected_version"));
  const decision = value(form, "decision").toUpperCase();
  const reason = value(form, "reason");

  if (
    !requestId
    || !Number.isInteger(expectedVersion)
    || expectedVersion < 1
    || !["APPROVED", "REJECTED"].includes(decision)
    || reason.length < 3
    || reason.length > 500
    || form.get("confirmed") !== "on"
  ) {
    redirect(destination("error", "Choose approve or reject, document a clinical reason, and confirm the review."));
  }

  const supabase = await createClient();
  if (decision === "APPROVED") {
    const { data: proposalData, error: proposalError } = await supabase
      .from("appointment_reduction_requests")
      .select("appointment_id,proposed_provider_id,proposed_location_id,proposed_start_time,proposed_end_time,proposed_resource_ids,patients!inner(timezone),appointments!inner(patient_id,service_id,authorization_id,telehealth)")
      .eq("id", requestId)
      .eq("status", "PENDING")
      .single();
    if (proposalError || !proposalData) {
      redirect(destination("error", "This pending request could not be revalidated. Refresh before deciding."));
    }
    const proposal = proposalData as unknown as ReductionProposal;
    const appointment = one(proposal.appointments);
    const patient = one(proposal.patients);
    const start = new Date(proposal.proposed_start_time);
    const end = new Date(proposal.proposed_end_time);
    const timeZone = patient?.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
    if (!appointment || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      redirect(destination("error", "The proposed appointment is incomplete and cannot be approved."));
    }
    const { ctx } = await loadHorizon({
      startDate: startOfWeek(start, timeZone),
      timeZone,
      includeOpaqueBusy: true,
    });
    const range = ctx.grid.rangeOf(start, end);
    const resourceIds = Array.isArray(proposal.proposed_resource_ids)
      ? proposal.proposed_resource_ids.filter((item): item is string => typeof item === "string")
      : [];
    if (!range) {
      redirect(destination("error", "The proposed appointment is outside the current scheduling horizon."));
    }
    const proof = evaluateBooking({
      appointment_id: proposal.appointment_id,
      patient_id: appointment.patient_id,
      service_id: appointment.service_id,
      provider_id: proposal.proposed_provider_id,
      location_id: proposal.proposed_location_id,
      authorization_id: appointment.authorization_id,
      resource_ids: resourceIds,
      range,
      telehealth: appointment.telehealth,
    }, ctx, {
      travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
      includeSoft: false,
    });
    if (!proof.valid) {
      const message = proof.violations.find((item) => item.severity === "HARD")?.message
        ?? "The proposed appointment is no longer legal.";
      redirect(destination("error", `${message} Reject this request or correct the schedule before approving.`));
    }
  }
  const { data, error } = await supabase.rpc("decide_appointment_reduction", {
    p_request_id: requestId,
    p_expected_version: expectedVersion,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) redirect(destination("error", databaseMessage(error.message)));

  const result = data as { appointment_id?: string; status?: string } | null;
  const appointmentId = result?.appointment_id;
  if (result?.status === "APPROVED" && appointmentId) {
    await reconcileAppointmentReminders(supabase, [appointmentId]);
  }

  revalidatePath("/reductions");
  revalidatePath("/notifications");
  revalidatePath("/schedule");
  if (appointmentId) revalidatePath(`/appointments/${appointmentId}`);

  if (result?.status === "STALE") {
    redirect(destination("notice", "The appointment changed before approval, so this request was marked stale and nothing was applied."));
  }
  redirect(destination(
    "notice",
    decision === "APPROVED"
      ? "Clinical approval recorded and the appointment change was applied."
      : "The proposed reduction was rejected and the appointment was left unchanged.",
  ));
}
