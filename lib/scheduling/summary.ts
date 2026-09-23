/**
 * Per-service summary for one patient's week.
 *
 * The job of this module is to keep four numbers visibly distinct, because the
 * spec is emphatic that collapsing them is the central modelling error:
 *
 *   authorized   what the payer will pay for      (authorizations)
 *   minimum      the clinical floor               (patient_service_requirements)
 *   target       what we are aiming at            (patient_service_requirements)
 *   scheduled    what is actually on the calendar (appointments)
 *
 * "Unused authorization" is the gap between authorized and scheduled. It is
 * NOT the same as available capacity (spec section 51) — the hours may be
 * unfillable for want of a provider — so it is reported plainly and never
 * described as schedulable.
 */

import { slotsToHours } from "../domain/slots";
import type { UUID } from "../domain/types";
import { ScheduleContext } from "../rules/context";
import { departmentSlot } from "./weekView";

export interface ServiceSummaryRow {
  service_id: UUID;
  service_code: string;
  service_name: string;
  department: string;
  departmentSlot: number;

  scheduled_hours: number;
  scheduled_sessions: number;

  /** From patient_service_requirements — clinical need. */
  minimum_hours: number | null;
  target_hours: number | null;
  maximum_hours: number | null;
  required_sessions: number | null;
  required: boolean;

  /** From authorizations — the payer's ceiling. */
  authorized_hours: number | null;
  unused_authorization: number | null;

  /** Whether the week satisfies what was required of this service. */
  met: boolean;
  /** Short reason when it is not met. */
  shortfall: string | null;
}

export interface PatientWeekSummary {
  rows: ServiceSummaryRow[];
  required_services_total: number;
  required_services_met: number;
}

export function summarisePatientWeek(
  ctx: ScheduleContext,
  patientId: UUID,
): PatientWeekSummary {
  const requirements = ctx.patientServiceRequirements.get(patientId) ?? [];
  const authorizations = ctx.authorizations.get(patientId) ?? [];

  // Every service the patient has a requirement, an authorization or an
  // appointment for — so a service scheduled without a requirement still shows.
  const serviceIds = new Set<UUID>([
    ...requirements.map((r) => r.service_id),
    ...authorizations.map((a) => a.service_id),
    ...(ctx.appointmentsByPatient.get(patientId) ?? []).map((a) => a.service_id),
  ]);

  const rows: ServiceSummaryRow[] = [];

  for (const serviceId of serviceIds) {
    const service = ctx.services.get(serviceId);
    if (!service) continue;

    const requirement = requirements.find((r) => r.service_id === serviceId) ?? null;
    const authorization = authorizations.find(
      (a) => a.service_id === serviceId && a.status === "ACTIVE",
    );

    const scheduledHours = slotsToHours(ctx.slotsScheduled(patientId, serviceId));
    const scheduledSessions = ctx.sessionsScheduled(patientId, serviceId);

    const authorizedHours = authorization?.authorized_hours ?? null;
    const unused =
      authorizedHours == null ? null : Math.max(0, authorizedHours - scheduledHours);

    const required = requirement?.required ?? false;
    let met = true;
    let shortfall: string | null = null;

    if (requirement) {
      const minSessions = requirement.minimum_sessions_per_week;
      const minHours = requirement.minimum_hours_per_week;

      if (minSessions != null && scheduledSessions < minSessions) {
        met = false;
        shortfall = `${minSessions - scheduledSessions} session${
          minSessions - scheduledSessions === 1 ? "" : "s"
        } short`;
      } else if (minHours != null && scheduledHours < minHours) {
        met = false;
        shortfall = `${round(minHours - scheduledHours)}h below clinical minimum`;
      } else if (
        requirement.target_hours_per_week != null &&
        scheduledHours < requirement.target_hours_per_week
      ) {
        // Below target but above the floor: the week is valid, just not optimal.
        shortfall = `${round(requirement.target_hours_per_week - scheduledHours)}h below target`;
      }
    }

    rows.push({
      service_id: serviceId,
      service_code: service.service_code,
      service_name: service.service_name,
      department: service.department,
      departmentSlot: departmentSlot(service.department),
      scheduled_hours: round(scheduledHours),
      scheduled_sessions: scheduledSessions,
      minimum_hours: requirement?.minimum_hours_per_week ?? null,
      target_hours: requirement?.target_hours_per_week ?? null,
      maximum_hours: requirement?.maximum_hours_per_week ?? null,
      required_sessions: requirement?.minimum_sessions_per_week ?? null,
      required,
      authorized_hours: authorizedHours,
      unused_authorization: unused == null ? null : round(unused),
      met,
      shortfall,
    });
  }

  // Required services first, then the largest commitment.
  rows.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      b.scheduled_hours - a.scheduled_hours ||
      a.service_name.localeCompare(b.service_name),
  );

  const requiredRows = rows.filter((r) => r.required);

  return {
    rows,
    required_services_total: requiredRows.length,
    required_services_met: requiredRows.filter((r) => r.met).length,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
