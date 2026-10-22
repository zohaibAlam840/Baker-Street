import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { queueAppointmentReminder } from "@/lib/communications/actions";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { formatDateTimeLocal, startOfWeek } from "@/lib/domain/time";
import {
  reportPatientCancellation,
  restoreCancelledAppointment,
} from "@/lib/recovery/actions";
import { createClient } from "@/lib/supabase/server";
import { updateAppointment } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

const EDITABLE_STATUSES = ["SCHEDULED", "CONFIRMED", "COMPLETED"] as const;

interface AppointmentAnchor {
  start_time: string;
  patients: { timezone: string | null } | { timezone: string | null }[] | null;
}

interface ReminderContact {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  timezone: string;
}

interface ReminderConsent {
  patient_contact_id: string;
  channel: "SMS" | "EMAIL";
  status: "GRANTED" | "REVOKED";
}

interface PendingReduction {
  id: string;
  scheduled_minutes_before: number;
  scheduled_minutes_after: number;
  target_minutes: number | null;
  request_reason: string;
  created_at: string;
}

export default async function AppointmentDetailPage({ params, searchParams }: {
  params: Promise<{ appointmentId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const [{ appointmentId }, query] = await Promise.all([params, searchParams]);
  const renderedAt = new Date().getTime();

  // Anchor the horizon to the appointment in the patient's timezone. Loading
  // the current clinic week first can omit Sunday/Monday boundary visits.
  const supabase = await createClient();
  const { data: anchorData, error: anchorError } = await supabase
    .from("appointments")
    .select("start_time, patients!inner(timezone)")
    .eq("id", appointmentId)
    .single();
  if (anchorError || !anchorData) notFound();

  const anchor = anchorData as unknown as AppointmentAnchor;
  const patientAnchor = Array.isArray(anchor.patients) ? anchor.patients[0] : anchor.patients;
  const displayTimeZone = patientAnchor?.timezone
    ?? process.env.SCHEDULING_TIMEZONE
    ?? "America/New_York";
  const horizonStart = startOfWeek(new Date(anchor.start_time), displayTimeZone);
  const { ctx, synthetic } = await loadHorizon({
    startDate: horizonStart,
    timeZone: displayTimeZone,
  });
  const appointment = ctx.rows.appointments.find((item) => item.id === appointmentId);
  if (!appointment) notFound();

  const patient = ctx.patients.get(appointment.patient_id);
  const provider = appointment.provider_id ? ctx.providers.get(appointment.provider_id) : null;
  const service = ctx.services.get(appointment.service_id);
  const location = appointment.location_id ? ctx.locations.get(appointment.location_id) : null;
  const resources = ctx.rows.appointmentResources
    .filter((item) => item.appointment_id === appointment.id)
    .map((item) => ctx.resources.get(item.resource_id)?.name)
    .filter((name): name is string => Boolean(name));
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: displayTimeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(appointment.start_time));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: displayTimeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const reductionResult = can(session.role, "schedule.book")
    ? await supabase
        .from("appointment_reduction_requests")
        .select("id,scheduled_minutes_before,scheduled_minutes_after,target_minutes,request_reason,created_at")
        .eq("appointment_id", appointment.id)
        .eq("status", "PENDING")
        .maybeSingle()
    : { data: null, error: null };
  const pendingReduction = reductionResult.data as PendingReduction | null;
  const reductionCheckFailed = Boolean(reductionResult.error);
  const canEdit = can(session.role, "schedule.book")
    && ["SCHEDULED", "CONFIRMED"].includes(appointment.status)
    && !pendingReduction
    && !reductionCheckFailed;
  const canManageRecovery = can(session.role, "recovery.manage");
  const canCancel = canManageRecovery
    && ["SCHEDULED", "CONFIRMED"].includes(appointment.status);
  const recoveryCaseResult = appointment.status === "CANCELLED"
    ? await supabase
        .from("recovery_cases")
        .select("id, requires_clinical_review")
        .eq("original_appointment_id", appointment.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };
  const restoreRequiresClinical = Boolean(recoveryCaseResult.data?.requires_clinical_review);
  const restoreCheckFailed = Boolean(recoveryCaseResult.error);
  const restoreWindowClosed = new Date(appointment.start_time).getTime() <= new Date().getTime();
  const canRestore = canManageRecovery
    && appointment.status === "CANCELLED"
    && !restoreCheckFailed
    && !restoreWindowClosed
    && (!restoreRequiresClinical || can(session.role, "schedule.approve_reduction"));
  const restoreNeedsClinical = canManageRecovery
    && appointment.status === "CANCELLED"
    && !restoreWindowClosed
    && restoreRequiresClinical
    && !can(session.role, "schedule.approve_reduction");
  const canQueueReminder = can(session.role, "communications.queue")
    && ["SCHEDULED", "CONFIRMED"].includes(appointment.status)
    && new Date(appointment.start_time).getTime() > renderedAt + 15 * 60_000;
  const relationshipDate = new Date(renderedAt).toISOString().slice(0, 10);
  const reminderContactsResult = canQueueReminder
    ? await supabase
        .from("patient_contacts")
        .select("id,name,relationship,phone,email,timezone")
        .eq("patient_id", appointment.patient_id)
        .eq("active", true)
        .eq("authorized_to_receive_information", true)
        .not("relationship_verified_at", "is", null)
        .lte("relationship_effective_start", relationshipDate)
        .or(`relationship_effective_end.is.null,relationship_effective_end.gte.${relationshipDate}`)
        .order("is_primary", { ascending: false })
    : { data: [] as ReminderContact[], error: null };
  const reminderContacts = (reminderContactsResult.data ?? []) as ReminderContact[];
  const reminderConsentsResult = canQueueReminder && reminderContacts.length
    ? await supabase.from("communication_consents").select("patient_contact_id,channel,status").in("patient_contact_id", reminderContacts.map((contact) => contact.id)).eq("status", "GRANTED").in("channel", ["SMS", "EMAIL"])
    : { data: [] as ReminderConsent[], error: null };
  const reminderConsents = (reminderConsentsResult.data ?? []) as ReminderConsent[];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/schedule?week=${ctx.grid.startDate}`} className="text-xs text-[var(--ink-secondary)] underline underline-offset-4">← Practice schedule</Link>
          <h1 className="mt-2 text-xl font-semibold text-[var(--ink-primary)]">{service?.service_name ?? "Appointment"}</h1>
          <p className="mt-1 text-sm text-[var(--ink-secondary)]">{date} · {time.format(new Date(appointment.start_time))}–{time.format(new Date(appointment.end_time))}</p>
        </div>
        <span className="rounded-full bg-[var(--surface-sunken)] px-3 py-1 text-xs font-medium text-[var(--ink-secondary)]">{appointment.status}</span>
      </div>

      {query.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-lg bg-[var(--brand-tint)] p-3 text-sm">{query.notice}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader
            title="Appointment details"
            sub={`${synthetic ? "Synthetic record" : "Live record"}${canEdit ? "" : " · read only"}`}
          />
          {canEdit ? (
            <form action={updateAppointment} className="mt-5 space-y-5">
              <input type="hidden" name="appointment_id" value={appointment.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Patient"><input disabled className={inputClass} defaultValue={patient ? `${patient.first_name} ${patient.last_name}` : "Unknown"} /></Field>
                <Field label="Service"><input disabled className={inputClass} defaultValue={service?.service_name ?? "Unknown"} /></Field>
                <Field label="Clinician"><select name="provider_id" className={inputClass} defaultValue={appointment.provider_id ?? ""}><option value="">Unassigned</option>{[...ctx.providers.values()].map((item) => <option key={item.id} value={item.id}>{item.first_name} {item.last_name}</option>)}</select></Field>
                <Field label="Location"><select name="location_id" className={inputClass} defaultValue={appointment.location_id ?? ""}><option value="">No location</option>{[...ctx.locations.values()].map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
                <Field label="Start"><input name="start_time" type="datetime-local" className={inputClass} defaultValue={formatDateTimeLocal(new Date(appointment.start_time), displayTimeZone)} /></Field>
                <Field label="End"><input name="end_time" type="datetime-local" className={inputClass} defaultValue={formatDateTimeLocal(new Date(appointment.end_time), displayTimeZone)} /></Field>
                <Field label="Status"><select name="status" className={inputClass} defaultValue={appointment.status}>{EDITABLE_STATUSES.map((value) => <option key={value}>{value}</option>)}</select></Field>
                <Field label="Scheduling protection"><select name="scheduling_flexibility" className={inputClass} defaultValue={appointment.scheduling_flexibility}>{["FLEXIBLE", "PROTECTED", "LOCKED"].map((value) => <option key={value}>{value}</option>)}</select></Field>
              </div>
              <Field label="Reason for change"><textarea required minLength={3} name="reason" className={`${inputClass} min-h-24`} placeholder="Document why this change is needed" /></Field>
              <ActionSubmit pendingLabel="Saving appointment…">Save appointment</ActionSubmit>
            </form>
          ) : (
            <dl className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Detail label="Patient" value={patient ? `${patient.first_name} ${patient.last_name}` : "Unknown"} />
              <Detail label="Service" value={service?.service_name ?? "Unknown"} />
              <Detail label="Clinician" value={provider ? `${provider.first_name} ${provider.last_name}` : "Unassigned"} />
              <Detail label="Location" value={location?.name ?? (appointment.telehealth ? "Telehealth" : "No location")} />
              <Detail label="Start" value={formatDateTimeLocal(new Date(appointment.start_time), displayTimeZone).replace("T", " ")} />
              <Detail label="End" value={formatDateTimeLocal(new Date(appointment.end_time), displayTimeZone).replace("T", " ")} />
              <Detail label="Status" value={appointment.status} />
              <Detail label="Scheduling protection" value={appointment.scheduling_flexibility} />
            </dl>
          )}
        </Card>

        <div className="space-y-4">
          <Card><CardHeader title="Booking context" /><dl className="mt-4 space-y-3 text-sm"><Row label="Authorization" value={appointment.authorization_id ? "Linked" : "None"} /><Row label="Delivery" value={appointment.telehealth ? "Telehealth" : "In person"} /><Row label="Resources" value={resources.join(", ") || "None"} /><Row label="Timezone" value={displayTimeZone} /></dl></Card>

          {pendingReduction && (
            <Card>
              <CardHeader title="Clinical review pending" sub="The appointment remains unchanged" />
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Current weekly care" value={`${pendingReduction.scheduled_minutes_before / 60}h`} />
                <Row label="Proposed weekly care" value={`${pendingReduction.scheduled_minutes_after / 60}h`} />
                <Row label="Clinical target" value={pendingReduction.target_minutes === null ? "Required service" : `${pendingReduction.target_minutes / 60}h`} />
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-[var(--ink-secondary)]">{pendingReduction.request_reason}</p>
              <Link href="/reductions" className="mt-4 grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4 text-sm font-medium">Open reduction review</Link>
            </Card>
          )}

          {reductionCheckFailed && can(session.role, "schedule.book") && (
            <Card>
              <CardHeader title="Editing temporarily unavailable" sub="Clinical review state could not be verified" />
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">Refresh before editing this appointment. No changes were made.</p>
            </Card>
          )}

          <Card><CardHeader title="Related records" /><div className="mt-4 grid gap-2 text-sm">{patient && <Link className="underline underline-offset-4" href={`/patients/${patient.id}?week=${ctx.grid.startDate}`}>Patient record</Link>}{provider && <Link className="underline underline-offset-4" href={`/providers/${provider.id}?week=${ctx.grid.startDate}`}>Clinician record</Link>}{appointment.authorization_id && <Link className="underline underline-offset-4" href={`/authorizations/${appointment.authorization_id}?week=${ctx.grid.startDate}`}>Authorization</Link>}</div></Card>

          {canQueueReminder && (
            <Card>
              <CardHeader title="Appointment reminder" sub="Choose a recipient who granted consent for this channel" />
              {(reminderContactsResult.error || reminderConsentsResult.error) ? (
                <p role="alert" className="mt-3 text-sm text-red-700">Recipients could not be verified. No reminder was queued.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {reminderConsents.flatMap((consent) => {
                    const contact = reminderContacts.find((item) => item.id === consent.patient_contact_id);
                    if (!contact || (consent.channel === "SMS" ? !contact.phone : !contact.email)) return [];
                    const latest = new Date(appointment.start_time).getTime() - 15 * 60_000;
                    const preferred = new Date(appointment.start_time).getTime() - 24 * 60 * 60_000;
                    const scheduled = new Date(Math.min(latest, Math.max(renderedAt + 5 * 60_000, preferred)));
                    return [
                      <details key={`${contact.id}:${consent.channel}`} className="rounded-xl border border-[var(--border-ring)] px-3">
                        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-[var(--ink-primary)]">{contact.name} · {consent.channel}</span>
                          <span className="text-[var(--ink-muted)]">{consent.channel === "SMS" ? maskPhone(contact.phone) : maskEmail(contact.email)}</span>
                        </summary>
                        <form action={queueAppointmentReminder} className="space-y-3 pb-3">
                          <input type="hidden" name="appointment_id" value={appointment.id} />
                          <input type="hidden" name="contact_id" value={contact.id} />
                          <input type="hidden" name="channel" value={consent.channel} />
                          <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                          <Field label={`Delivery time (${contact.timezone})`}>
                            <input required name="scheduled_for" type="datetime-local" className={inputClass} defaultValue={formatDateTimeLocal(scheduled, contact.timezone)} />
                          </Field>
                          <label className="flex min-h-11 items-start gap-3 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">
                            <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                            <span>I confirm this recipient, channel and delivery time. The privacy-safe template will not name the service.</span>
                          </label>
                          <ActionSubmit className="w-full" pendingLabel="Queuing reminder…">Queue reminder</ActionSubmit>
                        </form>
                      </details>,
                    ];
                  })}
                  {!reminderConsents.length && (
                    <p className="text-sm text-[var(--ink-secondary)]">No active contact has granted SMS or email consent. Update consent on the patient record first.</p>
                  )}
                  <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">The delivery provider is not connected yet. This creates queued work; it does not claim the reminder was sent.</p>
                </div>
              )}
            </Card>
          )}

          {canRestore && (
            <Card>
              <CardHeader title="Restore appointment" sub="This also closes open recovery work" />
              <form action={restoreCancelledAppointment} className="mt-4 space-y-3">
                <input type="hidden" name="appointment_id" value={appointment.id} />
                <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                <Field label="Reason for restoring">
                  <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Why is this visit being restored?" />
                </Field>
                <label className="flex min-h-11 items-start gap-3 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">
                  <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                  <span>I confirm the original visit should be restored and any open replacement work closed.</span>
                </label>
                <ActionSubmit tone="secondary" className="w-full" pendingLabel="Restoring appointment…">Restore appointment</ActionSubmit>
              </form>
            </Card>
          )}

          {restoreNeedsClinical && (
            <Card>
              <CardHeader title="Clinical review required" sub="Restore is unavailable for this role" />
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">
                This protected visit can only be restored by a clinical supervisor.
              </p>
              <Link href="/recovery" className="mt-4 grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4 text-sm">
                Open recovery queue
              </Link>
            </Card>
          )}

          {restoreCheckFailed && appointment.status === "CANCELLED" && canManageRecovery && (
            <Card>
              <CardHeader title="Restore temporarily unavailable" sub="Recovery safeguards could not be loaded" />
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">Refresh before attempting to restore this visit. No changes were made.</p>
            </Card>
          )}

          {restoreWindowClosed && appointment.status === "CANCELLED" && canManageRecovery && (
            <Card>
              <CardHeader title="Restore window closed" sub="Historical visits stay cancelled" />
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">
                The original start time has passed, so this visit cannot safely return to the active schedule.
              </p>
              <Link
                href={recoveryCaseResult.data?.id ? `/recovery/${recoveryCaseResult.data.id}` : "/recovery"}
                className="mt-4 grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4 text-sm"
              >
                Review recovery work
              </Link>
            </Card>
          )}

          {canCancel && (
            <Card>
              <CardHeader title="Cancel appointment" sub="The original visit remains in the audit history" />
              <form action={reportPatientCancellation} className="mt-4 space-y-3">
                <input type="hidden" name="appointment_id" value={appointment.id} />
                <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                <Field label="Cancellation reason">
                  <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Document why the visit was cancelled" />
                </Field>
                <label className="flex min-h-11 items-start gap-3 rounded-xl border border-[var(--rule-hairline)] p-3 text-sm text-[var(--ink-primary)]">
                  <input defaultChecked name="create_recovery" type="checkbox" className="mt-0.5 size-4" />
                  <span>Add this visit to schedule recovery so staff can offer a legal replacement.</span>
                </label>
                <label className="flex min-h-11 items-start gap-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">
                  <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                  <span>I confirm this cancellation was requested and the reason is accurate.</span>
                </label>
                <ActionSubmit tone="danger" className="w-full" pendingLabel="Cancelling appointment…">Cancel appointment</ActionSubmit>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--surface-sunken)] p-3">
      <dt className="text-xs font-medium text-[var(--ink-muted)]">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-[var(--ink-primary)]">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-[var(--ink-secondary)]">{label}</dt><dd className="text-right font-medium text-[var(--ink-primary)]">{value}</dd></div>;
}

function maskPhone(value: string | null) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Phone on file";
}

function maskEmail(value: string | null) {
  if (!value?.includes("@")) return "Email on file";
  return `•••@${value.split("@")[1]}`;
}
