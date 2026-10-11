"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { addDays } from "@/lib/domain/time";
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
    service_metrics: plan.service_metrics,
    bounded: optimization.status === "BOUNDED",
    runtime_ms: optimization.meta.runtime_ms,
  };
  const { data, error } = await supabase.rpc("approve_optimization_plan", {
    p_patient_id: patientId,
    p_date_start: week,
    p_date_end: addDays(week, 6),
    p_plan_key: planKey,
    p_plan: payload,
    p_summary: summary,
    p_reason: reason,
  });
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

  revalidatePath("/dashboard");
  revalidatePath("/schedule");
  revalidatePath("/approvals");
  revalidatePath(`/patients/${patientId}`);
  const added = Number((data as { appointments_added?: number } | null)?.appointments_added ?? payload.length);
  redirect(
    resultPath(
      patientId,
      week,
      "notice",
      `${added} appointment${added === 1 ? "" : "s"} approved and added atomically.`,
    ),
  );
}

function friendlyApprovalError(message: string): string {
  if (/booked while/i.test(message)) return "The schedule changed while you were reviewing it.";
  if (/authorization/i.test(message)) return "The authorization no longer has enough valid hours.";
  if (/resource|room/i.test(message)) return "A required room or resource is no longer available.";
  if (/credential/i.test(message)) return "A clinician credential is no longer valid.";
  if (/available|restriction/i.test(message)) return "Patient or clinician availability changed.";
  return "Live revalidation rejected this option.";
}
