"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { can } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { reconcileUpcomingAppointmentReminders } from "@/lib/communications/reconcile";
import { parseZonedDateTimeLocal } from "@/lib/domain/time";
import { createClient } from "@/lib/supabase/server";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function destination(kind: "error" | "notice", message: string): string {
  return `/time-off?${new URLSearchParams({ [kind]: message }).toString()}`;
}

function fail(message: string): never {
  redirect(destination("error", message));
}

function done(message: string): never {
  redirect(destination("notice", message));
}

function commandId(form: FormData): string {
  const id = value(form, "command_id");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    fail("This form expired. Refresh and try again.");
  }
  return id;
}

function requireConfirmation(form: FormData, message: string): void {
  if (form.get("confirmed") !== "on") fail(message);
}

function databaseMessage(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes("changed; refresh") || message.includes("version")) {
    return "This request changed while you were reviewing it. Refresh and try again.";
  }
  if (message.includes("overlapping pending")) {
    return "You already have a pending request that overlaps this time.";
  }
  if (message.includes("already unavailable") || message.includes("overlapping callout")) {
    return "The clinician is already unavailable during part of this window.";
  }
  if (message.includes("expired")) {
    return "This request has expired and can no longer be approved.";
  }
  if (message.includes("already decided") || message.includes("only a pending")) {
    return "This request was already decided. Refresh to see its current status.";
  }
  if (message.includes("permission") || message.includes("access required") || message.includes("only their own")) {
    return "You no longer have permission to complete this action.";
  }
  return "The time-off action could not be completed. Refresh and try again.";
}

export async function requestProviderTimeOff(form: FormData) {
  const session = await requireSession();
  if (!can(session.role, "availability.request")) {
    redirect("/no-access?permission=availability.request");
  }
  if (!session.providerId) fail("Your account is not connected to a clinician record.");

  const supabase = await createClient();
  const { data: provider, error: providerError } = await supabase
    .from("providers")
    .select("id,timezone")
    .eq("id", session.providerId)
    .single();
  if (providerError || !provider) fail("Your clinician record is unavailable.");

  const timeZone = provider.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  const start = parseZonedDateTimeLocal(value(form, "start_time"), timeZone);
  const end = parseZonedDateTimeLocal(value(form, "end_time"), timeZone);
  const reasonCategory = value(form, "reason_category").toUpperCase();
  const requestNote = value(form, "request_note");
  const now = Date.now();

  if (!start || !end || start.getTime() <= now || end <= start) {
    fail("Choose a valid future start and end time.");
  }
  if (start.getTime() > now + 366 * 24 * 60 * 60_000) {
    fail("Time off can be requested up to one year in advance.");
  }
  if (end.getTime() - start.getTime() > 14 * 24 * 60 * 60_000) {
    fail("One request can cover at most 14 days.");
  }
  if (!["PTO", "TRAINING", "OTHER"].includes(reasonCategory)) {
    fail("Choose a time-off reason category.");
  }
  if (requestNote.length < 3 || requestNote.length > 500) {
    fail("Add a request note between 3 and 500 characters.");
  }
  requireConfirmation(form, "Confirm the requested dates and times before submitting.");

  const { error } = await supabase.rpc("request_provider_time_off", {
    p_provider_id: session.providerId,
    p_start_time: start.toISOString(),
    p_end_time: end.toISOString(),
    p_reason_category: reasonCategory,
    p_request_note: requestNote,
    p_idempotency_key: `time-off:${session.userId}:${commandId(form)}`,
  });
  if (error) fail(databaseMessage(error.message));

  revalidatePath("/time-off");
  revalidatePath("/notifications");
  done("Time-off request submitted for scheduler review.");
}

export async function decideProviderTimeOff(form: FormData) {
  const session = await requireSession();
  if (!can(session.role, "availability.manage")) {
    redirect("/no-access?permission=availability.manage");
  }

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
    || reason.length > 1000
  ) {
    fail("Choose approve or reject and add a decision reason.");
  }
  requireConfirmation(form, "Confirm the decision after reviewing the exact time-off window.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_provider_time_off_request", {
    p_request_id: requestId,
    p_expected_version: expectedVersion,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) fail(databaseMessage(error.message));

  const result = data as { affected_count?: number; status?: string } | null;
  if (result?.status === "APPROVED") {
    await reconcileUpcomingAppointmentReminders(supabase);
  }
  revalidatePath("/time-off");
  revalidatePath("/notifications");
  revalidatePath("/recovery");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");

  if (decision === "APPROVED") {
    const affected = Number(result?.affected_count ?? 0);
    done(`Time off approved. ${affected} affected visit${affected === 1 ? " was" : "s were"} added to schedule recovery.`);
  }
  done("Time-off request rejected. The schedule was not changed.");
}

export async function cancelProviderTimeOff(form: FormData) {
  const session = await requireSession();
  if (!can(session.role, "availability.request")) {
    redirect("/no-access?permission=availability.request");
  }

  const requestId = value(form, "request_id");
  const expectedVersion = Number(value(form, "expected_version"));
  const reason = value(form, "reason");
  if (!requestId || !Number.isInteger(expectedVersion) || expectedVersion < 1 || reason.length < 3 || reason.length > 1000) {
    fail("Add a cancellation reason before withdrawing the request.");
  }
  requireConfirmation(form, "Confirm that this pending request should be withdrawn.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_provider_time_off_request", {
    p_request_id: requestId,
    p_expected_version: expectedVersion,
    p_reason: reason,
  });
  if (error) fail(databaseMessage(error.message));

  revalidatePath("/time-off");
  revalidatePath("/notifications");
  done("Pending time-off request withdrawn. The schedule was not changed.");
}
