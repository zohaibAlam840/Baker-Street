/**
 * What needs attention this week.
 *
 * The bell in the top bar was a button with no handler — decoration on every
 * screen in the product. Rather than remove it or invent a feed, this derives
 * alerts from data the engine already holds: a credential that has lapsed is
 * a fact about `provider_credentials`, not a notification someone has to
 * remember to send.
 *
 * Nothing here is stored, pushed or emailed. These are computed on each
 * request from the current snapshot, which means they cannot go stale and
 * there is no queue to get out of sync. A real notification system — delivery,
 * read state, digests — is a separate piece of work and is not in the
 * specification at all.
 */

import { slotsToHours } from "../domain/slots";
import type { ScheduleContext } from "../rules/context";
import type { UUID } from "../domain/types";

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  href: string;
  /** Who it concerns, so a scoped role only sees its own. */
  patientId?: UUID;
  providerId?: UUID;
  /**
   * Alerts sharing a key are the same underlying fact about different people.
   * Every ABA authorization in the demo clinic ends on the same date, which
   * produced six near-identical rows — a panel nobody would read twice.
   */
  groupKey?: string;
  /**
   * The plural phrase used once a group is collapsed, as a plain string.
   * It was a function until a server component tried to hand one of these to
   * a client component: functions do not cross that boundary, and neither
   * tsc nor eslint catches it — only rendering the page does.
   */
  groupPhrase?: string;
}

/** Days ahead that still count as "expiring", rather than merely dated. */
const EXPIRY_HORIZON_DAYS = 45;

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/**
 * Build the week's alerts, most severe first.
 *
 * `today` is passed in rather than read from the clock so the demo fixture and
 * the tests see the same week the rest of the app does.
 */
export function buildAlerts(ctx: ScheduleContext, today: string): Alert[] {
  const alerts: Alert[] = [];
  const week = ctx.grid.startDate;

  // ---- credentials -------------------------------------------------------
  // A lapsed credential is the one condition that makes a *booked* appointment
  // illegal rather than merely awkward, so it leads.
  for (const [providerId, credentials] of ctx.providerCredentials) {
    const provider = ctx.providers.get(providerId);
    if (!provider || provider.status !== "ACTIVE") continue;

    for (const credential of credentials) {
      if (!credential.expiration_date) continue;

      const days = daysBetween(today, credential.expiration_date);
      const lapsed = credential.status !== "ACTIVE" || days < 0;
      if (!lapsed && days > EXPIRY_HORIZON_DAYS) continue;

      const booked = (ctx.appointmentsByProvider.get(providerId) ?? []).length;

      alerts.push({
        id: `credential-${credential.id}`,
        severity: lapsed ? "critical" : "warning",
        title: lapsed
          ? `${provider.first_name} ${provider.last_name}: ${credential.credential_type} has lapsed`
          : `${provider.first_name} ${provider.last_name}: ${credential.credential_type} expires in ${days} days`,
        detail: lapsed
          ? booked > 0
            ? `${booked} appointments this week are affected — nothing further can be booked until it is renewed.`
            : "Nothing can be booked against this clinician until it is renewed."
          : `Expires ${credential.expiration_date}. Renew before it starts blocking bookings.`,
        href: `/providers/${providerId}?week=${week}`,
        providerId,
      });
    }
  }

  // ---- authorizations ----------------------------------------------------
  for (const [patientId, list] of ctx.authorizations) {
    const patient = ctx.patients.get(patientId);
    if (!patient) continue;

    for (const auth of list) {
      if (auth.status !== "ACTIVE") continue;
      const service = ctx.services.get(auth.service_id);
      const name = `${patient.first_name} ${patient.last_name}`;

      const days = daysBetween(today, auth.end_date);
      if (days >= 0 && days <= EXPIRY_HORIZON_DAYS) {
        alerts.push({
          id: `auth-expiry-${auth.id}`,
          severity: days <= 14 ? "critical" : "warning",
          title: `${name}: ${service?.service_name ?? "authorization"} runs out in ${days} days`,
          detail: `Authorization ${auth.authorization_number ?? ""} ends ${auth.end_date}. Renewals take time; starting late means a gap in care.`.trim(),
          href: `/authorizations?patient=${patientId}`,
          patientId,
          groupKey: `auth-expiry-${auth.service_id}-${auth.end_date}`,
          groupPhrase: `${service?.service_name ?? "authorizations"} run out in ${days} days`,
        });
      }

      // Funded hours nobody is using. Authorization is a ceiling, not a
      // target — but a large untouched balance usually means a scheduling
      // problem rather than a clinical decision.
      if (auth.authorized_hours != null) {
        const used = slotsToHours(ctx.slotsUsedAgainstAuthorization(auth.id));
        const remaining = auth.authorized_hours - used;
        if (remaining >= 10 && used / auth.authorized_hours < 0.6) {
          alerts.push({
            id: `auth-unused-${auth.id}`,
            severity: "info",
            title: `${name}: ${remaining}h of ${service?.service_name ?? "service"} authorized but unscheduled`,
            detail: `${used}h of ${auth.authorized_hours}h used. Funded hours are not the same as deliverable ones — check whether anyone is free.`,
            href: `/patients/${patientId}?week=${week}`,
            patientId,
          });
        }
      }
    }
  }

  // ---- clinical requirements not met -------------------------------------
  for (const [patientId, requirements] of ctx.patientServiceRequirements) {
    const patient = ctx.patients.get(patientId);
    if (!patient || patient.status !== "ACTIVE") continue;

    for (const requirement of requirements) {
      if (!requirement.required || requirement.minimum_hours_per_week == null) continue;

      const scheduled = slotsToHours(
        ctx.slotsScheduled(patientId, requirement.service_id),
      );
      if (scheduled >= requirement.minimum_hours_per_week) continue;

      const service = ctx.services.get(requirement.service_id);
      alerts.push({
        id: `requirement-${requirement.id}`,
        severity: scheduled === 0 ? "critical" : "warning",
        title: `${patient.first_name} ${patient.last_name} is below the clinical minimum for ${service?.service_name ?? "a required service"}`,
        detail: `${scheduled}h scheduled against a minimum of ${requirement.minimum_hours_per_week}h. This is a clinical floor, not a payer figure.`,
        href: `/patients/${patientId}?week=${week}`,
        patientId,
      });
    }
  }

  // ---- unassigned appointments -------------------------------------------
  const unassigned = ctx.appointments.filter((a) => !a.provider_id);
  if (unassigned.length > 0) {
    alerts.push({
      id: "unassigned",
      severity: "warning",
      title: `${unassigned.length} appointment${unassigned.length === 1 ? " has" : "s have"} no clinician`,
      detail: "Scheduled time with nobody to deliver it.",
      href: `/schedule?week=${week}`,
    });
  }

  const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Narrow the list to what a role may see.
 *
 * A therapist gets alerts about themselves and the patients they actually
 * treat. Everything else is somebody else's business, and the same rule that
 * keeps them off the dashboard applies to the bell.
 */
export function scopeAlerts(
  alerts: Alert[],
  ctx: ScheduleContext,
  providerId: UUID | null,
  /**
   * Whether this user is limited to their own work. The caller owns
   * authorization scope so scheduling code stays independent of application
   * role types and reusable by the optimizer and related workflows.
   */
  restricted: boolean,
): Alert[] {
  if (!restricted || !providerId) return alerts;

  const caseload = new Set(
    (ctx.appointmentsByProvider.get(providerId) ?? []).map((a) => a.patient_id),
  );

  return alerts.filter((alert) => {
    if (alert.providerId) return alert.providerId === providerId;
    if (alert.patientId) return caseload.has(alert.patientId);
    // Practice-wide items (unassigned appointments) belong to whoever
    // schedules, not to an individual clinician.
    return false;
  });
}

/**
 * Collapse repeats of the same underlying fact.
 *
 * Run this *after* scoping, never before: a therapist who can see one of the
 * six affected patients should get that patient's alert by name, not "6
 * patients" of whom five are none of their business.
 *
 * Two of a kind stay as they are — collapsing a pair hides a name to save one
 * line, which is a bad trade.
 */
export function groupAlerts(alerts: Alert[], threshold = 3): Alert[] {
  const counts = new Map<string, number>();
  for (const alert of alerts) {
    if (!alert.groupKey) continue;
    counts.set(alert.groupKey, (counts.get(alert.groupKey) ?? 0) + 1);
  }

  const emitted = new Set<string>();
  const out: Alert[] = [];

  for (const alert of alerts) {
    const key = alert.groupKey;
    const count = key ? (counts.get(key) ?? 0) : 0;

    if (!key || count < threshold) {
      out.push(alert);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);

    out.push({
      ...alert,
      id: `group-${key}`,
      title: alert.groupPhrase
        ? `${count} patients: ${alert.groupPhrase}`
        : alert.title,
      // The per-person detail quoted one authorization number, which reads as
      // a contradiction beside a title counting sixteen of them.
      detail: alert.groupPhrase
        ? "Renewals take time; starting late means a gap in care. Open the authorizations list to work through them."
        : alert.detail,
      // A group cannot point at one person's record.
      href: "/authorizations",
      patientId: undefined,
    });
  }

  return out;
}
