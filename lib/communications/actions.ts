"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { can, type Permission } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { reconcileUpcomingAppointmentReminders } from "@/lib/communications/reconcile";
import {
  isCommunicationChannel,
  isIanaTimeZone,
  normalizeClock,
  normalizeEmail,
  normalizeLanguageTag,
  normalizePhone,
  validQuietHours,
  type CommunicationChannel,
} from "@/lib/communications/validation";
import { parseZonedDateTimeLocal } from "@/lib/domain/time";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_MESSAGE_TYPES = ["RECOVERY_OFFER", "RECOVERY_UPDATE"] as const;

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const nullable = (form: FormData, name: string) => field(form, name) || null;
const checked = (form: FormData, name: string) => form.get(name) === "on";

function version(form: FormData, path: string, required = true): number | null {
  const raw = field(form, "expected_version");
  if (!raw && !required) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) fail(path, "This record version is invalid. Refresh and try again.");
  return parsed;
}

function finish(path: string, key: "error" | "notice", message: string): never {
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}${key}=${encodeURIComponent(message)}`);
}

function fail(path: string, message: string): never {
  finish(path, "error", message);
}

function done(path: string, message: string): never {
  finish(path, "notice", message);
}

function requireUuid(value: string, label: string, path: string) {
  if (!UUID.test(value)) fail(path, `${label} could not be identified.`);
  return value;
}

function requireConfirmation(form: FormData, path: string, message: string) {
  if (!checked(form, "confirmed")) fail(path, message);
}

async function authorized(permission: Permission, path: string) {
  const session = await requireSession();
  if (!can(session.role, permission)) fail("/no-access", "You do not have permission for this action.");
  return { session, supabase: await createClient(), path };
}

function safeRpcMessage(message: string, fallback: string) {
  const lower = message.toLowerCase();
  if (lower.includes("opt-out") || lower.includes("unsubscribe") || lower.includes("complaint") || lower.includes("re-consent")) return "This destination requires documented verified or signed re-consent before it can be enabled again.";
  if (lower.includes("consent")) return "This recipient has not granted consent for that channel.";
  if (lower.includes("contact method")) return "That contact does not have a usable address for this channel.";
  if (lower.includes("quiet hours")) return "Choose a delivery time outside the recipient's quiet hours.";
  if (lower.includes("already sent")) return "This communication has already been sent and cannot be changed.";
  if (lower.includes("changed") || lower.includes("version")) return "This record changed while you were editing it. Refresh and try again.";
  if (lower.includes("not found") || lower.includes("access")) return "This record is unavailable or outside your permitted scope.";
  return fallback;
}

export async function savePatientContact(form: FormData) {
  const patientId = field(form, "patient_id");
  const path = UUID.test(patientId) ? `/patients/${patientId}` : "/patients";
  const { supabase } = await authorized("communications.manage", path);
  requireUuid(patientId, "Patient", path);

  const contactId = nullable(form, "contact_id");
  if (contactId) requireUuid(contactId, "Contact", path);
  let pushEndpoint: string | null = null;
  if (contactId) {
    const existing = await supabase.from("patient_contacts").select("push_endpoint").eq("id", contactId).eq("patient_id", patientId).maybeSingle();
    if (existing.error || !existing.data) fail(path, "This contact is unavailable or outside your permitted scope.");
    pushEndpoint = existing.data.push_endpoint;
  }
  const name = field(form, "name");
  const relationship = field(form, "relationship");
  const phoneInput = nullable(form, "phone");
  const emailInput = nullable(form, "email");
  const phone = phoneInput ? normalizePhone(phoneInput) : null;
  const email = emailInput ? normalizeEmail(emailInput) : null;
  const preferredLanguage = normalizeLanguageTag(field(form, "preferred_language") || "en");
  const timeZone = field(form, "timezone") || "America/New_York";
  const quietStartInput = nullable(form, "quiet_hours_start");
  const quietEndInput = nullable(form, "quiet_hours_end");
  const quietStart = quietStartInput ? normalizeClock(quietStartInput) : null;
  const quietEnd = quietEndInput ? normalizeClock(quietEndInput) : null;
  const isLegalGuardian = checked(form, "is_legal_guardian");
  const guardianAuthority = isLegalGuardian ? field(form, "guardian_authority") : "NONE";

  if (name.length < 2 || name.length > 120) fail(path, "Enter a contact name between 2 and 120 characters.");
  if (relationship.length < 2 || relationship.length > 80) fail(path, "Enter the contact's relationship to the patient.");
  if (!phoneInput && !emailInput && !pushEndpoint) fail(path, "Add a mobile number or email address.");
  if (phoneInput && !phone) fail(path, "Enter a valid mobile number, including its country code.");
  if (emailInput && !email) fail(path, "Enter a valid email address.");
  if (!preferredLanguage) fail(path, "Choose a valid language code, such as en or es-US.");
  if (!isIanaTimeZone(timeZone)) fail(path, "Choose a valid timezone.");
  if (!["NONE", "CUSTODIAL", "MEDICAL", "LIMITED", "OTHER"].includes(guardianAuthority) || (isLegalGuardian && guardianAuthority === "NONE")) {
    fail(path, "Choose the legal guardian's authority.");
  }
  if ((quietStartInput || quietEndInput) && (!quietStartInput || !quietEndInput || !validQuietHours(quietStartInput, quietEndInput))) {
    fail(path, "Quiet hours need different start and end times.");
  }
  requireConfirmation(form, path, "Confirm that these contact details are appropriate for scheduling messages.");

  const { error } = await supabase.rpc("save_patient_contact", {
    p_patient_id: patientId,
    p_contact_id: contactId,
    p_name: name,
    p_relationship: relationship,
    p_phone: phone,
    p_email: email,
    p_push_endpoint: pushEndpoint,
    p_is_primary: checked(form, "is_primary"),
    p_authorized_to_receive_information: checked(form, "authorized"),
    p_is_legal_guardian: isLegalGuardian,
    p_guardian_authority: guardianAuthority,
    p_preferred_language: preferredLanguage,
    p_timezone: timeZone,
    p_quiet_hours_start: quietStart,
    p_quiet_hours_end: quietEnd,
    p_active: checked(form, "active"),
    p_expected_version: version(form, path, !!contactId),
    p_idempotency_key: requireUuid(field(form, "command_id"), "Request", path),
  });
  if (error) fail(path, safeRpcMessage(error.message, "The contact could not be saved. Try again."));
  revalidatePath(path);
  done(path, contactId ? "Contact details updated." : "Contact added. Set consent before sending messages.");
}

export async function setContactChannelConsent(form: FormData) {
  const patientId = field(form, "patient_id");
  const path = UUID.test(patientId) ? `/patients/${patientId}` : "/patients";
  const { supabase } = await authorized("communications.manage", path);
  requireUuid(patientId, "Patient", path);
  const contactId = requireUuid(field(form, "contact_id"), "Contact", path);
  const channel = field(form, "channel");
  const status = field(form, "status");
  if (!isCommunicationChannel(channel)) fail(path, "Choose SMS, email or push.");
  if (!["GRANTED", "REVOKED"].includes(status)) fail(path, "Choose a valid consent decision.");
  requireConfirmation(form, path, "Confirm that this consent decision matches the recipient's recorded choice.");

  const { error } = await supabase.rpc("set_contact_channel_consent", {
    p_contact_id: contactId,
    p_channel: channel,
    p_granted: status === "GRANTED",
    p_source: field(form, "source") || "STAFF_RECORDED",
    p_expected_version: version(form, path, field(form, "expected_version") !== ""),
    p_idempotency_key: requireUuid(field(form, "command_id"), "Request", path),
  });
  if (error) fail(path, safeRpcMessage(error.message, "Consent could not be updated. Try again."));
  revalidatePath(path);
  revalidatePath("/communications");
  done(path, `${channel === "SMS" ? "SMS" : "Email"} consent updated.`);
}

function scheduledFor(form: FormData, path: string, timeZone: string) {
  const raw = field(form, "scheduled_for");
  const date = parseZonedDateTimeLocal(raw, timeZone);
  if (!date) fail(path, "Choose a valid delivery time in the recipient's timezone.");
  const now = Date.now();
  if (date.getTime() < now - 60_000) fail(path, "The delivery time cannot be in the past.");
  if (date.getTime() > now + 90 * 86_400_000) fail(path, "Schedule messages no more than 90 days ahead.");
  return date.toISOString();
}

function communicationInput(form: FormData, path: string) {
  const contactId = requireUuid(field(form, "contact_id"), "Contact", path);
  const commandId = requireUuid(field(form, "command_id"), "Request", path);
  const channel = field(form, "channel");
  if (!isCommunicationChannel(channel)) fail(path, "Choose SMS, email or push.");
  requireConfirmation(form, path, "Confirm the recipient, channel, and delivery time before queuing this message.");
  return { contactId, commandId, channel: channel as CommunicationChannel };
}

export async function queueAppointmentReminder(form: FormData) {
  const appointmentValue = field(form, "appointment_id");
  const path = UUID.test(appointmentValue) ? `/appointments/${appointmentValue}` : "/communications";
  const { supabase } = await authorized("communications.queue", path);
  const appointmentId = requireUuid(appointmentValue, "Appointment", path);
  const input = communicationInput(form, path);
  const { data: contact, error: contactError } = await supabase.from("patient_contacts").select("timezone").eq("id", input.contactId).maybeSingle();
  if (contactError || !contact?.timezone) fail(path, "The recipient timezone could not be verified.");
  const deliveryTime = scheduledFor(form, path, contact.timezone);
  const { error } = await supabase.rpc("queue_appointment_reminder", {
    p_appointment_id: appointmentId,
    p_contact_id: input.contactId,
    p_channel: input.channel,
    p_scheduled_for: deliveryTime,
    p_idempotency_key: input.commandId,
  });
  if (error) fail(path, safeRpcMessage(error.message, "The reminder could not be queued. Try again."));
  revalidatePath(path);
  revalidatePath("/communications");
  done(path, "Appointment reminder queued.");
}

export async function queueRecoveryMessage(form: FormData) {
  const recoveryCaseValue = field(form, "recovery_case_id");
  const path = UUID.test(recoveryCaseValue) ? `/recovery/${recoveryCaseValue}` : "/communications";
  const { supabase } = await authorized("communications.queue", path);
  const recoveryCaseId = requireUuid(recoveryCaseValue, "Recovery case", path);
  const input = communicationInput(form, path);
  const messageType = field(form, "message_type");
  if (!(RECOVERY_MESSAGE_TYPES as readonly string[]).includes(messageType)) fail(path, "Choose a valid recovery message type.");
  const recoveryOfferId = nullable(form, "recovery_offer_id");
  if (messageType === "RECOVERY_OFFER") requireUuid(recoveryOfferId ?? "", "Recovery offer", path);
  if (messageType === "RECOVERY_UPDATE" && recoveryOfferId) fail(path, "A recovery update cannot be attached to an offer.");
  const { data: contact, error: contactError } = await supabase.from("patient_contacts").select("timezone").eq("id", input.contactId).maybeSingle();
  if (contactError || !contact?.timezone) fail(path, "The recipient timezone could not be verified.");
  const deliveryTime = scheduledFor(form, path, contact.timezone);
  const { error } = await supabase.rpc("queue_recovery_message", {
    p_recovery_case_id: recoveryCaseId,
    p_recovery_offer_id: recoveryOfferId,
    p_contact_id: input.contactId,
    p_channel: input.channel,
    p_message_type: messageType,
    p_scheduled_for: deliveryTime,
    p_idempotency_key: input.commandId,
  });
  if (error) fail(path, safeRpcMessage(error.message, "The recovery message could not be queued. Try again."));
  revalidatePath(path);
  revalidatePath("/communications");
  done(path, "Recovery message queued.");
}

export async function retryCommunicationJob(form: FormData) {
  const id = field(form, "job_id");
  const path = UUID.test(id) ? `/communications/${id}` : "/communications";
  const { supabase } = await authorized("communications.manage", path);
  requireUuid(id, "Communication", path);
  const commandId = requireUuid(field(form, "command_id"), "Request", path);
  const reason = field(form, "reason");
  if (reason.length < 3 || reason.length > 500) fail(path, "Enter a short reason for retrying this delivery.");
  requireConfirmation(form, path, "Confirm that this failed delivery should be retried.");
  const { error } = await supabase.rpc("retry_communication_job", { p_job_id: id, p_expected_version: version(form, path), p_reason: reason, p_idempotency_key: commandId });
  if (error) fail(path, safeRpcMessage(error.message, "The communication could not be retried. Try again."));
  revalidatePath(path);
  revalidatePath("/communications");
  done(path, "Communication returned to the queue.");
}

export async function cancelCommunicationJob(form: FormData) {
  const id = field(form, "job_id");
  const path = UUID.test(id) ? `/communications/${id}` : "/communications";
  const { supabase } = await authorized("communications.manage", path);
  requireUuid(id, "Communication", path);
  const commandId = requireUuid(field(form, "command_id"), "Request", path);
  const reason = field(form, "reason");
  if (reason.length < 3 || reason.length > 500) fail(path, "Enter a short reason for cancelling this delivery.");
  requireConfirmation(form, path, "Confirm that this pending communication should be cancelled.");
  const { error } = await supabase.rpc("cancel_communication_job", { p_job_id: id, p_expected_version: version(form, path), p_reason: reason, p_idempotency_key: commandId });
  if (error) fail(path, safeRpcMessage(error.message, "The communication could not be cancelled. Try again."));
  revalidatePath(path);
  revalidatePath("/communications");
  done(path, "Communication cancelled before delivery.");
}

export async function syncUpcomingReminders(form: FormData) {
  const path = "/communications";
  const { supabase } = await authorized("communications.manage", path);
  requireConfirmation(form, path, "Confirm that upcoming reminders should be reconciled with the current schedule and consent records.");
  const { data, error } = await reconcileUpcomingAppointmentReminders(supabase);
  if (error) fail(path, safeRpcMessage(error.message, "Upcoming reminders could not be reconciled. Try again."));
  const result = data as {
    processed_count?: number;
    ensured_count?: number;
    cancelled_count?: number;
    failed_count?: number;
  } | null;
  const processed = Number(result?.processed_count ?? 0);
  const ensured = Number(result?.ensured_count ?? 0);
  const cancelled = Number(result?.cancelled_count ?? 0);
  const failed = Number(result?.failed_count ?? 0);
  revalidatePath(path);
  done(
    path,
    `Reconciled ${processed} appointment${processed === 1 ? "" : "s"}: ${ensured} reminder${ensured === 1 ? "" : "s"} ready, ${cancelled} stale cancelled${failed ? `, ${failed} need review` : ""}.`,
  );
}
