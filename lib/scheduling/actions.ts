"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { reconcileUpcomingAppointmentReminders } from "@/lib/communications/reconcile";
import { loadHorizon } from "@/lib/data/snapshot";
import { addDays, parseZonedDateTimeLocal } from "@/lib/domain/time";
import { FlatTravelModel } from "@/lib/rules/travel";
import { createClient } from "@/lib/supabase/server";
import { optimizePatientWeek } from "./optimizer";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function resultPath(patientId: string, week: string, key: "error" | "notice", message: string) {
  const query = new URLSearchParams({ patient: patientId, week, [key]: message });
  return `/approvals?${query.toString()}`;
}

/**
 * Recompute the selected plan from fresh RLS-scoped data, then hand only that
 * server-generated payload to the atomic database function. Client JSON is
 * never accepted, and a plan ID that disappeared is treated as stale.
 */
export async function approveOptimizationPlan(form: FormData) {
  const session = await requirePermission("schedule.approve");
  const patientId = value(form, "patient_id");
  const week = value(form, "week");
  const planId = value(form, "plan_id");
  const reason = value(form, "reason");
  const path = resultPath(patientId, week, "error", "The plan could not be approved.");

  if (!patientId || !/^\d{4}-\d{2}-\d{2}$/.test(week) || !planId) redirect(path);
  if (reason.length < 3) {
    redirect(resultPath(patientId, week, "error", "Document a short approval reason."));
  }

  const planKey = `${session.userId}:${patientId}:${week}:${planId}`;
  const supabase = await createClient();
  const { data: committed, error: committedError } = await supabase
    .from("optimization_requests")
    .select("id")
    .eq("idempotency_key", planKey)
    .maybeSingle();
  if (committedError) {
    redirect(resultPath(patientId, week, "error", "Approval history could not be checked. Try again."));
  }
  if (committed) {
    redirect(
      resultPath(
        patientId,
        week,
        "notice",
        "This plan was already approved. No duplicate appointments were added.",
      ),
    );
  }

  const { data: patient, error: patientError } = await supabase
    .from("patients")
    .select("timezone")
    .eq("id", patientId)
    .single();
  if (patientError || !patient) {
    redirect(resultPath(patientId, week, "error", "The patient is no longer available to optimize."));
  }
  const { ctx } = await loadHorizon({
    startDate: week,
    timeZone: patient.timezone ?? undefined,
    includeOpaqueBusy: true,
  });
  const optimization = optimizePatientWeek(ctx, {
    patient_id: patientId,
    max_solutions: 5,
    start_step_slots: 1,
    move_not_before: new Date(),
    travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
  });
  const plan = optimization.plans.find((candidate) => candidate.id === planId);
  if (!plan) {
    redirect(
      resultPath(
        patientId,
        week,
        "error",
        "This option is stale because availability changed. Review the refreshed options before approving.",
      ),
    );
  }
  if (!plan.approvable) {
    redirect(
      resultPath(
        patientId,
        week,
        "error",
        "This diagnostic option does not preserve required care and cannot be approved.",
      ),
    );
  }

  const payload = plan.appointments.map((appointment) => ({
    service_id: appointment.service_id,
    provider_id: appointment.provider_id,
    authorization_id: appointment.authorization_id,
    location_id: appointment.location_id,
    resource_ids: appointment.resource_ids,
    telehealth: false,
    start_time: ctx.grid.instantOf(appointment.start_slot).toISOString(),
    end_time: ctx.grid.instantOf(appointment.end_slot).toISOString(),
  }));
  const summary = {
    plan_id: plan.id,
    strategy: plan.strategy,
    added_hours: plan.added_hours,
    required_services_met: plan.required_services_met,
    provider_changes: plan.provider_changes,
    appointments_moved: plan.moves.length,
    service_metrics: plan.service_metrics,
    bounded: optimization.status === "BOUNDED",
    runtime_ms: optimization.meta.runtime_ms,
  };
  if (plan.moves.length > 1) {
    redirect(resultPath(patientId, week, "error", "This plan exceeds the one-move approval boundary."));
  }
  const move = plan.moves[0];
  const movePayload = move
    ? {
        appointment_id: move.appointment_id,
        service_id: move.service_id,
        status: move.status,
        flexibility: move.flexibility,
        authorization_id: move.authorization_id,
        telehealth: move.telehealth,
        old_start_time: ctx.grid.instantOf(move.old_start_slot).toISOString(),
        old_end_time: ctx.grid.instantOf(move.old_end_slot).toISOString(),
        old_provider_id: move.old_provider_id,
        old_location_id: move.old_location_id,
        old_resource_ids: move.old_resource_ids,
        new_start_time: ctx.grid.instantOf(move.replacement.start_slot).toISOString(),
        new_end_time: ctx.grid.instantOf(move.replacement.end_slot).toISOString(),
        new_provider_id: move.replacement.provider_id,
        new_location_id: move.replacement.location_id,
        new_resource_ids: move.replacement.resource_ids,
      }
    : null;
  const approval = movePayload
    ? await supabase.rpc("approve_optimization_plan_with_move", {
        p_patient_id: patientId,
        p_date_start: week,
        p_date_end: addDays(week, 6),
        p_plan_key: planKey,
        p_additions: payload,
        p_move: movePayload,
        p_summary: summary,
        p_reason: reason,
      })
    : await supabase.rpc("approve_optimization_plan", {
        p_patient_id: patientId,
        p_date_start: week,
        p_date_end: addDays(week, 6),
        p_plan_key: planKey,
        p_plan: payload,
        p_summary: summary,
        p_reason: reason,
      });
  const { data, error } = approval;
  if (error) {
    redirect(
      resultPath(
        patientId,
        week,
        "error",
        `${friendlyApprovalError(error.message)} No appointments were changed.`,
      ),
    );
  }
  if (session.role === "SCHEDULER") {
    await reconcileUpcomingAppointmentReminders(supabase);
  }

  revalidatePath("/dashboard");
  revalidatePath("/schedule");
  revalidatePath("/approvals");
  revalidatePath(`/patients/${patientId}`);
  const added = Number((data as { appointments_added?: number } | null)?.appointments_added ?? payload.length);
  const moved = Number((data as { appointments_moved?: number } | null)?.appointments_moved ?? plan.moves.length);
  redirect(
    resultPath(
      patientId,
      week,
      "notice",
      `${added} appointment${added === 1 ? "" : "s"} added${moved ? ` and ${moved} flexible visit moved` : ""} atomically.`,
    ),
  );
}

/**
 * Recompute the referenced option before recording a human reject/defer
 * decision. This prevents a client from manufacturing a plan summary or
 * attaching a decision to an option that no longer exists.
 */
export async function recordOptimizationPlanDecision(form: FormData) {
  await requirePermission("schedule.reject");
  const patientId = value(form, "patient_id");
  const week = value(form, "week");
  const planId = value(form, "plan_id");
  const decision = value(form, "decision");
  const reason = value(form, "reason");
  const deferredLocal = value(form, "deferred_until");
  const invalidPath = resultPath(patientId, week, "error", "The plan decision could not be recorded.");

  if (!patientId || !/^\d{4}-\d{2}-\d{2}$/.test(week) || !planId || planId.length > 200) {
    redirect(invalidPath);
  }
  if (!['REJECTED', 'DEFERRED'].includes(decision)) {
    redirect(resultPath(patientId, week, "error", "Choose reject or defer."));
  }
  if (reason.length < 3 || reason.length > 500) {
    redirect(resultPath(patientId, week, "error", "Document a reason between 3 and 500 characters."));
  }

  const supabase = await createClient();
  const { data: patient, error: patientError } = await supabase
    .from("patients")
    .select("timezone")
    .eq("id", patientId)
    .single();
  if (patientError || !patient) {
    redirect(resultPath(patientId, week, "error", "The patient is no longer available to optimize."));
  }
  const timeZone = patient.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  let deferredUntil: Date | null = null;
  if (decision === "DEFERRED") {
    deferredUntil = parseZonedDateTimeLocal(deferredLocal, timeZone);
    const weekBoundary = parseZonedDateTimeLocal(`${addDays(week, 7)}T00:00`, timeZone);
    if (!deferredUntil || !weekBoundary || deferredUntil <= new Date() || deferredUntil >= weekBoundary) {
      redirect(
        resultPath(
          patientId,
          week,
          "error",
          "Choose a future follow-up time before the selected scheduling week ends.",
        ),
      );
    }
  }

  const { ctx } = await loadHorizon({
    startDate: week,
    timeZone,
    includeOpaqueBusy: true,
  });
  const optimization = optimizePatientWeek(ctx, {
    patient_id: patientId,
    max_solutions: 5,
    start_step_slots: 1,
    move_not_before: new Date(),
    travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
  });
  const plan = optimization.plans.find((candidate) => candidate.id === planId);
  if (!plan) {
    redirect(
      resultPath(
        patientId,
        week,
        "error",
        "This option is stale because availability changed. Review the refreshed options before deciding.",
      ),
    );
  }

  const summary = {
    plan_id: plan.id,
    label: plan.label,
    strategy: plan.strategy,
    added_hours: plan.added_hours,
    appointment_count: plan.appointments.length,
    appointments_moved: plan.moves.length,
    required_services_met: plan.required_services_met,
    targets_met: plan.targets_met,
    provider_changes: plan.provider_changes,
    bounded: optimization.status === "BOUNDED",
  };
  const { data, error } = await supabase.rpc("record_optimization_plan_decision", {
    p_patient_id: patientId,
    p_date_start: week,
    p_date_end: addDays(week, 6),
    p_plan_id: plan.id,
    p_decision: decision,
    p_reason: reason,
    p_deferred_until: deferredUntil?.toISOString() ?? null,
    p_plan_summary: summary,
  });
  if (error) {
    redirect(
      resultPath(
        patientId,
        week,
        "error",
        error.message.includes("permission")
          ? "You no longer have permission to decide this plan."
          : error.message.includes("already approved")
            ? "This option was already approved and can no longer be rejected or deferred."
            : "The plan decision was not recorded. Refresh and try again.",
      ),
    );
  }

  revalidatePath("/approvals");
  revalidatePath("/audit");
  const result = data as { already_decided?: boolean; decision?: string } | null;
  const already = result?.already_decided === true;
  const label = result?.decision === "DEFERRED" ? "deferred" : "rejected";
  redirect(
    resultPath(
      patientId,
      week,
      "notice",
      already
        ? `This option was already ${label}; the earlier decision was preserved.`
        : decision === "DEFERRED"
          ? "Option deferred and removed from the active queue until follow-up is due."
          : "Option rejected and removed from the active queue.",
    ),
  );
}

function friendlyApprovalError(message: string): string {
  if (/active (rejected|deferred) decision/i.test(message)) return "This option was already rejected or deferred by another reviewer.";
  if (/appointment changed|no longer exists|after it has started/i.test(message)) return "The visit selected for moving changed or already started.";
  if (/only a flexible appointment/i.test(message)) return "The visit is no longer flexible enough for optimizer movement.";
  if (/booked while/i.test(message)) return "The schedule changed while you were reviewing it.";
  if (/authorization/i.test(message)) return "The authorization no longer has enough valid hours.";
  if (/resource|room/i.test(message)) return "A required room or resource is no longer available.";
  if (/credential/i.test(message)) return "A clinician credential is no longer valid.";
  if (/available|restriction/i.test(message)) return "Patient or clinician availability changed.";
  return "Live revalidation rejected this option.";
}
