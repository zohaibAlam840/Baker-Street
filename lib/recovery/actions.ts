"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { can } from "@/lib/auth/roles";
import { requirePermission, requireSession } from "@/lib/auth/session";
import {
  reconcileAppointmentReminders,
  reconcileUpcomingAppointmentReminders,
} from "@/lib/communications/reconcile";
import { loadHorizon } from "@/lib/data/snapshot";
import { parseZonedDateTimeLocal, startOfWeek } from "@/lib/domain/time";
import type { Appointment, AppointmentStatus } from "@/lib/domain/types";
import { ScheduleContext } from "@/lib/rules/context";
import { createClient } from "@/lib/supabase/server";

import { suggestScheduleRecovery } from "./engine";
import type { RecoveryOption, ScheduleRecoveryResult } from "./types";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";

function withMessage(path: string, kind: "error" | "notice", message: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${kind}=${encodeURIComponent(message)}`;
}

function fail(path: string, message: string): never {
  redirect(withMessage(path, "error", message));
}

function done(path: string, message: string): never {
  redirect(withMessage(path, "notice", message));
}

function databaseMessage(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes("stale") || message.includes("version")) {
    return "This recovery case changed while you were reviewing it. Refresh and try again.";
  }
  if (message.includes("expired")) return "This offer expired. Create a fresh offer.";
  if (message.includes("past appointments")) {
    return "This appointment cannot return to the active schedule because its original start time has passed.";
  }
  if (message.includes("permission") || message.includes("caseload")) {
    return "You no longer have access to complete this recovery action.";
  }
  if (
    message.includes("overlap") ||
    message.includes("available") ||
    message.includes("authorization") ||
    message.includes("credential") ||
    message.includes("capacity") ||
    message.includes("travel")
  ) {
    return "That option is no longer available under the current scheduling rules. Choose another option.";
  }
  return "The recovery action could not be completed. Refresh and try again.";
}

async function recoverySession(permission: "recovery.manage" | "recovery.offer") {
  const session = await requireSession();
  if (!can(session.role, permission)) fail("/no-access", "You do not have permission for this action.");
  return { session, supabase: await createClient() };
}

function safeInteger(raw: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function commandId(form: FormData, path: string): string {
  const id = value(form, "command_id");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) fail(path, "This form expired. Refresh and try again.");
  return id;
}

function requireConfirmation(form: FormData, path: string, message: string): void {
  if (!checked(form, "confirmed")) fail(path, message);
}

/** Report a dated provider callout. Providers may only report their own. */
export async function reportProviderCallout(form: FormData) {
  const session = await requireSession();
  const manager = can(session.role, "recovery.manage");
  if (!manager && !can(session.role, "recovery.report_own")) {
    fail("/no-access", "You do not have permission to report a callout.");
  }

  // Only the organization-wide Scheduler role may call out another provider.
  // A caseload-scoped Clinical user must be linked to, and report as, themself.
  const canChooseProvider = can(session.role, "availability.manage");
  const providerId = canChooseProvider ? value(form, "provider_id") : session.providerId ?? "";
  const path = "/recovery";
  if (!providerId || (!canChooseProvider && providerId !== session.providerId)) {
    fail(path, "Your account is not connected to a clinician record.");
  }

  const supabase = await createClient();
  const { data: provider, error: providerError } = await supabase
    .from("providers")
    .select("id, timezone")
    .eq("id", providerId)
    .single();
  if (providerError || !provider) fail(path, "The clinician record is unavailable.");

  const timeZone = provider.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  const start = parseZonedDateTimeLocal(value(form, "start_time"), timeZone);
  const end = parseZonedDateTimeLocal(value(form, "end_time"), timeZone);
  const reasonCategory = value(form, "reason_category");
  const operationalNote = value(form, "operational_note");
  if (!start || !end || end <= start) fail(path, "Choose a valid start and end time.");
  if (end.getTime() - start.getTime() > 14 * 24 * 60 * 60_000) {
    fail(path, "One callout can cover at most 14 days.");
  }
  if (!["ILLNESS", "EMERGENCY", "PTO", "TRAINING", "OTHER"].includes(reasonCategory)) {
    fail(path, "Choose a callout reason category.");
  }
  if (!canChooseProvider && ["PTO", "TRAINING"].includes(reasonCategory)) {
    fail(path, "Planned PTO and training must be submitted through the time-off request queue.");
  }
  if (!canChooseProvider && start.getTime() > Date.now() + 24 * 60 * 60_000) {
    fail(path, "Urgent self-reported callouts may start at most 24 hours ahead. Request planned time off instead.");
  }
  if (operationalNote.length > 500) fail(path, "The operational note must be 500 characters or fewer.");
  requireConfirmation(form, path, "Confirm the callout and its affected visit cancellations.");

  const idempotencyKey = ["provider-callout", session.userId, commandId(form, path)].join(":");
  const { data, error } = await supabase.rpc("report_provider_callout", {
    p_provider_id: providerId,
    p_start_time: start.toISOString(),
    p_end_time: end.toISOString(),
    p_reason_category: reasonCategory,
    p_operational_note: operationalNote || null,
    p_idempotency_key: idempotencyKey,
  });
  if (error) fail(path, databaseMessage(error.message));

  const affected = Number((data as { affected_count?: number } | null)?.affected_count ?? 0);
  revalidatePath("/recovery");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
  done(path, affected === 1 ? "Callout recorded. One visit was added to recovery." : `Callout recorded. ${affected} visits were added to recovery.`);
}

/** Cancel a visit and optionally create a recoverable work item atomically. */
export async function reportPatientCancellation(form: FormData) {
  const { session, supabase } = await recoverySession("recovery.manage");
  const appointmentId = value(form, "appointment_id");
  const path = `/appointments/${appointmentId}`;
  const reason = value(form, "reason");
  if (!appointmentId || reason.length < 3 || reason.length > 500) {
    fail(path, "Enter a cancellation reason between 3 and 500 characters.");
  }
  requireConfirmation(form, path, "Confirm the cancellation before continuing.");
  const { data, error } = await supabase.rpc("report_patient_cancellation", {
    p_appointment_id: appointmentId,
    p_reason: reason,
    p_create_recovery: checked(form, "create_recovery"),
    p_idempotency_key: `patient-cancellation:${session.userId}:${appointmentId}:${commandId(form, path)}`,
  });
  if (error) fail(path, databaseMessage(error.message));

  const cancellation = data as { case_id?: string; recovery_requested?: boolean } | null;
  const caseId = cancellation?.case_id;
  const recoveryRequested = cancellation?.recovery_requested === true;
  if (session.role === "SCHEDULER") {
    await reconcileAppointmentReminders(supabase, [appointmentId]);
  }
  revalidatePath("/recovery");
  revalidatePath("/schedule");
  revalidatePath(path);
  done(
    recoveryRequested && caseId ? `/recovery/${caseId}` : path,
    recoveryRequested
      ? "Visit cancelled and added to recovery."
      : "Visit cancelled without replacement work. Its history is preserved.",
  );
}

/** Withdraw a mistaken callout. The database restores every original visit or rolls back all of it. */
export async function withdrawProviderCallout(form: FormData) {
  const session = await requireSession();
  if (!can(session.role, "recovery.manage") && !can(session.role, "recovery.report_own")) {
    fail("/no-access", "You do not have permission to withdraw a callout.");
  }
  const disruptionId = value(form, "disruption_id");
  const reason = value(form, "reason");
  const path = value(form, "return_to").startsWith("/recovery")
    ? value(form, "return_to")
    : "/recovery";
  if (!disruptionId || reason.length < 3 || reason.length > 500) {
    fail(path, "Add a reason for withdrawing the callout.");
  }
  requireConfirmation(form, path, "Confirm the whole callout should be withdrawn.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("withdraw_provider_callout", {
    p_disruption_id: disruptionId,
    p_reason: reason,
    p_idempotency_key: `withdraw-callout:${session.userId}:${disruptionId}:${commandId(form, path)}`,
  });
  if (error) fail(path, databaseMessage(error.message));
  const result = data as { restored_count?: number; past_count?: number } | null;
  const restored = Number(result?.restored_count ?? 0);
  const past = Number(result?.past_count ?? 0);
  if (session.role === "SCHEDULER" && restored > 0) {
    await reconcileUpcomingAppointmentReminders(supabase);
  }
  revalidatePath("/recovery");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
  done(
    path,
    `Callout withdrawn. ${restored} future visit${restored === 1 ? " was" : "s were"} restored.${past ? ` ${past} already-started visit${past === 1 ? " remains" : "s remain"} cancelled.` : ""}`,
  );
}

interface RecoveryCaseRow {
  id: string;
  patient_id: string;
  disruption_id: string;
  original_appointment_id: string;
  status: string;
  version: number;
  locked_override_approved: boolean;
}

interface RecoveryDisruptionRow {
  id: string;
  disruption_type: "PROVIDER_CALLOUT" | "PATIENT_CANCELLATION";
  provider_id: string | null;
}

export interface LoadedSuggestions {
  recoveryCase: RecoveryCaseRow;
  disruption: RecoveryDisruptionRow;
  original: Appointment & { patients?: { timezone?: string } | { timezone?: string }[] | null };
  result: ScheduleRecoveryResult;
}

/** Reload and re-prove options from RLS-scoped live data; never trust client plan JSON. */
export async function loadRecoverySuggestions(caseId: string): Promise<LoadedSuggestions | null> {
  await requirePermission("recovery.view");
  const supabase = await createClient();
  const { data: recoveryCase, error: caseError } = await supabase
    .from("recovery_cases")
    .select("id, patient_id, disruption_id, original_appointment_id, status, version, locked_override_approved")
    .eq("id", caseId)
    .single();
  if (caseError) {
    if (caseError.code === "PGRST116") return null;
    throw new Error("The recovery case could not be loaded safely.");
  }
  if (!recoveryCase) return null;

  const [disruptionResult, originalResult] = await Promise.all([
    supabase
      .from("schedule_disruptions")
      .select("id, disruption_type, provider_id")
      .eq("id", recoveryCase.disruption_id)
      .single(),
    supabase
      .from("appointments")
      .select("*, patients!inner(timezone)")
      .eq("id", recoveryCase.original_appointment_id)
      .single(),
  ]);
  if (disruptionResult.error || originalResult.error) {
    throw new Error("The affected visit could not be loaded safely.");
  }
  const disruption = disruptionResult.data;
  const original = originalResult.data;
  if (!disruption || !original) return null;

  const typedOriginal = original as unknown as LoadedSuggestions["original"];
  const patient = Array.isArray(typedOriginal.patients) ? typedOriginal.patients[0] : typedOriginal.patients;
  const timeZone = patient?.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  const { ctx } = await loadHorizon({
    startDate: startOfWeek(new Date(typedOriginal.start_time), timeZone),
    dayCount: 14,
    timeZone,
    includeOpaqueBusy: true,
  });
  const revivedRows = ctx.rows.appointments.map((appointment) =>
    appointment.id === typedOriginal.id
      ? {
          ...appointment,
          status: "SCHEDULED" as AppointmentStatus,
          scheduling_flexibility: recoveryCase.locked_override_approved
            ? "PROTECTED" as const
            : appointment.scheduling_flexibility,
        }
      : appointment,
  );
  if (!revivedRows.some((appointment) => appointment.id === typedOriginal.id)) {
    revivedRows.push({
      ...typedOriginal,
      status: "SCHEDULED",
      scheduling_flexibility: recoveryCase.locked_override_approved
        ? "PROTECTED"
        : typedOriginal.scheduling_flexibility,
    });
  }
  const proofContext = new ScheduleContext(ctx.grid, {
    ...ctx.rows,
    appointments: revivedRows,
  });
  const result = suggestScheduleRecovery(proofContext, {
    kind: "APPOINTMENT",
    appointment_id: typedOriginal.id,
  }, {
    max_options_per_appointment: 12,
    max_candidates_per_appointment: 40_000,
    not_before: new Date(),
  });
  return {
    recoveryCase: recoveryCase as RecoveryCaseRow,
    disruption: disruption as RecoveryDisruptionRow,
    original: typedOriginal,
    result,
  };
}

/** A clinical supervisor may release a locked visit into protected recovery. */
export async function releaseLockedRecoveryCase(form: FormData) {
  await requirePermission("schedule.approve_reduction");
  const caseId = value(form, "case_id");
  const path = `/recovery/${caseId}`;
  const expectedVersion = safeInteger(value(form, "expected_version"), -1, -1, 2_147_483_647);
  const reason = value(form, "reason");
  if (!caseId || expectedVersion < 1 || reason.length < 3 || reason.length > 500) {
    fail(path, "Add a clinical reason before releasing this locked visit.");
  }
  requireConfirmation(form, path, "Confirm this locked visit may enter protected recovery.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("release_locked_recovery_case", {
    p_case_id: caseId,
    p_expected_version: expectedVersion,
    p_reason: reason,
  });
  if (error) fail(path, databaseMessage(error.message));
  revalidatePath(path);
  revalidatePath("/recovery");
  done(path, "Clinical release recorded. Protected replacement options are now available.");
}

export async function createRecoveryOffer(form: FormData) {
  const { supabase } = await recoverySession("recovery.offer");
  const caseId = value(form, "case_id");
  const path = `/recovery/${caseId}`;
  const expectedVersion = safeInteger(value(form, "expected_version"), -1, -1, 2_147_483_647);
  const optionId = value(form, "option_id");
  const reason = value(form, "reason");
  if (!caseId || expectedVersion < 1 || reason.length < 3 || reason.length > 500) {
    fail(path, "Add a short reason before creating the offer.");
  }

  // A mobile connection can deliver the same form again after the first
  // response was lost. Treat the already-created canonical offer as success
  // before applying the case-version check below.
  const { data: existingPending } = await supabase
    .from("recovery_offers")
    .select("id, expires_at")
    .eq("recovery_case_id", caseId)
    .eq("candidate_key", optionId)
    .eq("status", "PENDING")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existingPending) {
    revalidatePath(path);
    done(path, "This offer is already pending a response.");
  }

  const loaded = await loadRecoverySuggestions(caseId);
  if (!loaded || loaded.recoveryCase.version !== expectedVersion) {
    fail(path, "This recovery case changed. Refresh before creating an offer.");
  }
  if (!["OPEN", "OFFERED", "DEFERRED"].includes(loaded.recoveryCase.status)) {
    fail(path, "This recovery case is already closed.");
  }
  const option = loaded.result.appointments
    .flatMap((appointment) => appointment.options)
    .find((candidate) => candidate.id === optionId);
  if (!option) fail(path, "That option is no longer legal. Choose a current option.");

  const expiryMinutes = safeInteger(value(form, "expiry_minutes"), 60, 5, 1_440);
  const now = Date.now();
  const optionStartsAt = new Date(option.start_time).getTime();
  if (!Number.isFinite(optionStartsAt) || optionStartsAt <= now + 7 * 60_000) {
    fail(path, "That visit starts too soon for a reliable outreach window. Choose a later option.");
  }
  // Keep at least one minute between offer expiry and the proposed visit.
  // The clamp also protects a slow mobile submission after the page rendered.
  const expiresAt = new Date(Math.min(
    now + expiryMinutes * 60_000,
    optionStartsAt - 60_000,
  )).toISOString();
  const { error } = await supabase.rpc("create_recovery_offer", {
    p_case_id: caseId,
    p_expected_version: expectedVersion,
    p_candidate_key: option.id,
    p_provider_id: option.provider_id,
    p_location_id: option.location_id,
    p_start_time: option.start_time,
    p_end_time: option.end_time,
    p_telehealth: option.telehealth,
    p_authorization_id: option.authorization_id,
    p_resource_ids: option.resource_ids,
    p_expires_at: expiresAt,
    p_reason: reason,
  });
  if (error) fail(path, databaseMessage(error.message));
  revalidatePath(path);
  revalidatePath("/recovery");
  done(path, "Offer recorded. Confirm the response before the offer expires.");
}

function sameOfferOption(
  offer: {
    candidate_key: string;
    proposed_provider_id: string;
    proposed_location_id: string | null;
    proposed_start_time: string;
    proposed_end_time: string;
    proposed_telehealth: boolean;
    proposed_authorization_id: string | null;
    proposed_resource_ids: string[] | null;
  },
  option: RecoveryOption,
): boolean {
  const offeredResources = [...(offer.proposed_resource_ids ?? [])].sort();
  const optionResources = [...option.resource_ids].sort();
  return offer.candidate_key === option.id &&
    offer.proposed_provider_id === option.provider_id &&
    offer.proposed_location_id === option.location_id &&
    new Date(offer.proposed_start_time).getTime() === new Date(option.start_time).getTime() &&
    new Date(offer.proposed_end_time).getTime() === new Date(option.end_time).getTime() &&
    offer.proposed_telehealth === option.telehealth &&
    offer.proposed_authorization_id === option.authorization_id &&
    offeredResources.length === optionResources.length &&
    offeredResources.every((resource, index) => resource === optionResources[index]);
}

export async function respondRecoveryOffer(form: FormData) {
  const { session, supabase } = await recoverySession("recovery.offer");
  const offerId = value(form, "offer_id");
  const caseId = value(form, "case_id");
  const path = `/recovery/${caseId}`;
  const decision = value(form, "decision").toUpperCase();
  const reason = value(form, "reason");
  const provenance = value(form, "provenance");
  const expectedVersion = safeInteger(value(form, "expected_version"), -1, -1, 2_147_483_647);
  if (!["ACCEPTED", "DECLINED"].includes(decision) || reason.length < 3 || reason.length > 500) {
    fail(path, "Record whether the offer was accepted or declined and add a short note.");
  }
  requireConfirmation(form, path, "Confirm the recorded response before continuing.");

  let responseContactId: string | null = null;
  let responseChannel: "SMS" | "EMAIL" | "PUSH" | "MANUAL_PHONE" | "IN_PERSON" | null = null;
  let communicationJobId: string | null = null;
  if (provenance.startsWith("DELIVERED:")) {
    communicationJobId = provenance.slice("DELIVERED:".length);
    const { data: delivery } = await supabase
      .from("communication_jobs")
      .select("id,patient_contact_id,channel,status")
      .eq("id", communicationJobId)
      .eq("recovery_offer_id", offerId)
      .eq("status", "DELIVERED")
      .maybeSingle();
    if (!delivery || !["SMS", "EMAIL", "PUSH"].includes(delivery.channel)) {
      fail(path, "Choose a delivered message for this exact offer, or record a manual response.");
    }
    responseContactId = delivery.patient_contact_id;
    responseChannel = delivery.channel as "SMS" | "EMAIL" | "PUSH";
  } else {
    const [method, contactId] = provenance.split(":");
    if (!/^[0-9a-f-]{36}$/i.test(contactId ?? "") || !["MANUAL_PHONE", "IN_PERSON"].includes(method)) {
      fail(path, "Choose the contact and how their response was received.");
    }
    const relationshipDate = new Date().toISOString().slice(0, 10);
    const { data: contact } = await supabase
      .from("patient_contacts")
      .select("id")
      .eq("id", contactId)
      .eq("active", true)
      .eq("authorized_to_receive_information", true)
      .not("relationship_verified_at", "is", null)
      .lte("relationship_effective_start", relationshipDate)
      .or(`relationship_effective_end.is.null,relationship_effective_end.gte.${relationshipDate}`)
      .maybeSingle();
    if (!contact) fail(path, "That contact is no longer verified, authorized, active, or available in your scope.");
    responseContactId = contact.id;
    responseChannel = method as "MANUAL_PHONE" | "IN_PERSON";
  }

  const { data: existingOffer, error: offerError } = await supabase
    .from("recovery_offers")
    .select("status, committed_appointment_id, candidate_key, proposed_provider_id, proposed_location_id, proposed_start_time, proposed_end_time, proposed_telehealth, proposed_authorization_id, proposed_resource_ids")
    .eq("id", offerId)
    .eq("recovery_case_id", caseId)
    .single();
  if (offerError || !existingOffer) fail(path, "This offer is no longer available.");
  if (existingOffer.status === decision) {
    revalidatePath(path);
    done(
      existingOffer.committed_appointment_id
        ? `/appointments/${existingOffer.committed_appointment_id}`
        : path,
      decision === "ACCEPTED"
        ? "Offer was already accepted and the replacement visit is booked."
        : "This decline was already recorded.",
    );
  }

  if (decision === "ACCEPTED") {
    const loaded = await loadRecoverySuggestions(caseId);
    const option = loaded?.result.appointments
      .flatMap((appointment) => appointment.options)
      .find((candidate) => candidate.id === existingOffer.candidate_key);
    if (!loaded || loaded.recoveryCase.version !== expectedVersion || !option || !sameOfferOption(existingOffer, option)) {
      fail(path, "This offer is stale or no longer legal. Refresh and create a new offer.");
    }
  }

  const { data, error } = await supabase.rpc("respond_recovery_offer_with_contact", {
    p_offer_id: offerId,
    p_expected_version: expectedVersion,
    p_decision: decision,
    p_reason: reason,
    p_contact_id: responseContactId,
    p_response_channel: responseChannel,
    p_communication_job_id: communicationJobId,
    p_idempotency_key: commandId(form, path),
  });
  if (error) fail(path, databaseMessage(error.message));
  const response = data as { appointment_id?: string; status?: string } | null;
  if (response?.status === "EXPIRED") {
    revalidatePath(path);
    revalidatePath("/recovery");
    done(path, "The offer expired before the response was saved. The case is open for a fresh offer.");
  }
  if (response?.status && response.status !== decision) {
    fail(path, "The offer changed while the response was being saved. Refresh and review its current status.");
  }
  const appointmentId = response?.appointment_id;
  if (session.role === "SCHEDULER" && appointmentId) {
    await reconcileAppointmentReminders(supabase, [appointmentId]);
  }
  revalidatePath(path);
  revalidatePath("/recovery");
  revalidatePath("/schedule");
  done(appointmentId ? `/appointments/${appointmentId}` : path, decision === "ACCEPTED" ? "Offer accepted and replacement visit booked." : "Decline recorded. The case is ready for another option.");
}

export async function setRecoveryCaseState(form: FormData) {
  const { supabase } = await recoverySession("recovery.manage");
  const caseId = value(form, "case_id");
  const path = `/recovery/${caseId}`;
  const status = value(form, "status").toUpperCase();
  const reason = value(form, "reason");
  const expectedVersion = safeInteger(value(form, "expected_version"), -1, -1, 2_147_483_647);
  if (!["OPEN", "DEFERRED", "CLOSED"].includes(status) || reason.length < 3 || reason.length > 500) {
    fail(path, "Choose a valid case action and add a short reason.");
  }
  let deferredUntil: string | null = null;
  if (status === "DEFERRED") {
    const hours = safeInteger(value(form, "defer_hours"), 24, 1, 168);
    deferredUntil = new Date(Date.now() + hours * 60 * 60_000).toISOString();
  }
  const { error } = await supabase.rpc("set_recovery_case_state", {
    p_case_id: caseId,
    p_expected_version: expectedVersion,
    p_status: status,
    p_reason: reason,
    p_deferred_until: deferredUntil,
  });
  if (error) fail(path, databaseMessage(error.message));
  revalidatePath(path);
  revalidatePath("/recovery");
  done(status === "CLOSED" ? "/recovery" : path, status === "DEFERRED" ? "Case deferred and kept in the queue." : status === "OPEN" ? "Case returned to the open queue." : "Case closed with an audit reason.");
}

export async function restoreCancelledAppointment(form: FormData) {
  const { session, supabase } = await recoverySession("recovery.manage");
  const appointmentId = value(form, "appointment_id");
  const path = `/appointments/${appointmentId}`;
  const reason = value(form, "reason");
  if (!appointmentId || reason.length < 3 || reason.length > 500) {
    fail(path, "Add a reason before restoring the appointment.");
  }
  requireConfirmation(form, path, "Confirm the original visit should be restored.");
  const { error } = await supabase.rpc("restore_cancelled_appointment", {
    p_appointment_id: appointmentId,
    p_reason: reason,
    p_idempotency_key: `appointment-restore:${session.userId}:${appointmentId}:${commandId(form, path)}`,
  });
  if (error) fail(path, databaseMessage(error.message));
  if (session.role === "SCHEDULER") {
    await reconcileAppointmentReminders(supabase, [appointmentId]);
  }
  revalidatePath(path);
  revalidatePath("/recovery");
  revalidatePath("/schedule");
  done(path, "Appointment restored and its open recovery work closed.");
}
