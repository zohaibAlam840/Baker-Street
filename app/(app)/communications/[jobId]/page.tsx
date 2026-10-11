import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { cancelCommunicationJob, retryCommunicationJob } from "@/lib/communications/actions";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface CommunicationJob {
  id: string;
  patient_id: string;
  patient_contact_id: string;
  appointment_id: string | null;
  recovery_case_id: string | null;
  message_type: string;
  channel: string;
  status: string;
  template_key: string;
  scheduled_for: string;
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
  attempt_count: number;
  last_error_category: string | null;
  version: number;
}

interface AttemptRow {
  id: string;
  attempt_number: number;
  outcome: string;
  provider: string | null;
  error_category: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ContactRow {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  preferred_language: string;
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

export default async function CommunicationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [session, route, query] = await Promise.all([requirePermission("communications.view"), params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(route.jobId)) notFound();
  const supabase = await createClient();
  const jobResult = await supabase
    .from("communication_jobs")
    .select("id,patient_id,patient_contact_id,appointment_id,recovery_case_id,message_type,channel,status,template_key,scheduled_for,created_at,delivered_at,cancelled_at,attempt_count,last_error_category,version")
    .eq("id", route.jobId)
    .maybeSingle();
  if (jobResult.error) {
    throw new Error("The communication delivery record could not be loaded.", { cause: jobResult.error });
  }
  if (!jobResult.data) notFound();
  const job = jobResult.data as CommunicationJob;

  const [contactResult, patientResult, attemptsResult] = await Promise.all([
    supabase
      .from("patient_contacts")
      .select("id,name,relationship,phone,email,preferred_language,timezone,quiet_hours_start,quiet_hours_end")
      .eq("id", job.patient_contact_id)
      .maybeSingle(),
    supabase.from("patients").select("id,external_id").eq("id", job.patient_id).maybeSingle(),
    supabase
      .from("communication_delivery_attempts")
      .select("id,attempt_number,outcome,provider,error_category,started_at,completed_at")
      .eq("communication_job_id", job.id)
      .order("attempt_number", { ascending: false })
      .limit(50),
  ]);
  const loadError = contactResult.error || patientResult.error || attemptsResult.error;
  const contact = contactResult.data as ContactRow | null;
  const attempts = (attemptsResult.data ?? []) as AttemptRow[];
  const canManage = can(session.role, "communications.manage");
  const permanentFailure = ["PERMANENT_FAILURE", "REJECTED"].includes(attempts[0]?.outcome ?? "")
    || ["COMPLAINT", "OPT_OUT", "HARD_BOUNCE", "INVALID_DESTINATION"].includes(job.last_error_category ?? "");
  const canRetry = canManage && job.status === "FAILED" && !permanentFailure;
  const canCancel = canManage && job.status === "QUEUED";

  return (
    <div className="space-y-4">
      <Link href="/communications" className="inline-flex min-h-11 items-center text-xs text-[var(--ink-secondary)]">← All communications</Link>

      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}
      {loadError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">Some delivery history could not be loaded. Refresh before taking action.</p>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">{humanize(job.message_type)}</p>
            <h1 className="mt-1 text-xl font-semibold text-[var(--ink-primary)]">Communication delivery record</h1>
            <p className="mt-1 text-xs text-[var(--ink-secondary)]">Patient record {patientResult.data?.external_id ?? "in your permitted scope"}</p>
          </div>
          <StatusPill status={job.status} />
        </div>
        <dl className="mt-5 grid gap-4 border-t border-[var(--rule-hairline)] pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <Datum label="Channel" value={channelLabel(job.channel)} />
          <Datum label="Scheduled" value={formatMoment(job.scheduled_for, contact?.timezone)} />
          <Datum label="Attempts" value={String(job.attempt_count)} />
          <Datum label="Template" value={humanize(job.template_key)} />
        </dl>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recipient and consent" sub="Message content is intentionally not shown" />
          {contact ? (
            <dl className="mt-4 space-y-3 text-sm">
              <Datum label="Recipient" value={`${contact.name} · ${contact.relationship}`} />
              <Datum label="Destination" value={job.channel === "SMS" ? maskPhone(contact.phone) : job.channel === "EMAIL" ? maskEmail(contact.email) : "Secure push endpoint on file"} />
              <Datum label="Language" value={contact.preferred_language || "Not recorded"} />
              <Datum label="Timezone" value={contact.timezone || "Not recorded"} />
              <Datum label="Quiet hours" value={contact.quiet_hours_start && contact.quiet_hours_end ? `${contact.quiet_hours_start.slice(0, 5)}–${contact.quiet_hours_end.slice(0, 5)}` : "None recorded"} />
            </dl>
          ) : (
            <p className="mt-4 text-sm text-[var(--ink-secondary)]">Recipient details are unavailable or outside your current scope.</p>
          )}
          <p className="mt-4 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs leading-relaxed text-[var(--ink-secondary)]">
            Fixed privacy-safe templates use only a generic reminder or scheduling-update notice. Patient names, service names, diagnoses, authorization details and clinical notes are never placed in the delivery body.
          </p>
        </Card>

        <Card>
          <CardHeader title="Source record" sub="Open the workflow that created this item" />
          <div className="mt-4 space-y-2">
            {job.appointment_id && <SourceLink href={`/appointments/${job.appointment_id}`} label="Open appointment" />}
            {job.recovery_case_id && <SourceLink href={`/recovery/${job.recovery_case_id}`} label="Open recovery case" />}
            <SourceLink href={`/patients/${job.patient_id}`} label="Open patient contacts" />
          </div>
          {!job.appointment_id && !job.recovery_case_id && (
            <p className="mt-4 text-sm text-[var(--ink-secondary)]">No source record is attached.</p>
          )}
        </Card>
      </div>

      {(canRetry || canCancel) && !loadError && (
        <Card>
          <CardHeader title="Delivery controls" sub="Every action is authenticated and audited" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {canRetry && (
              <form action={retryCommunicationJob} className="rounded-xl bg-[var(--surface-sunken)] p-3">
                <input type="hidden" name="job_id" value={job.id} />
                <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                <input type="hidden" name="expected_version" value={job.version} />
                <p className="text-sm font-medium text-[var(--ink-primary)]">Retry failed delivery</p>
                <p className="mt-1 text-xs text-[var(--ink-secondary)]">Consent and destination are rechecked before this returns to the queue.</p>
                <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg bg-white p-3 text-xs text-[var(--ink-secondary)]">
                  <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                  <span>I reviewed the recipient and want to retry this delivery.</span>
                </label>
                <label className="mt-3 block text-xs font-medium text-[var(--ink-primary)]">Reason<textarea required minLength={3} maxLength={500} name="reason" className="mt-1 min-h-20 w-full rounded-lg border border-[var(--border-ring)] bg-white p-3 text-base font-normal" placeholder="Why is retry appropriate?" /></label>
                <ActionSubmit className="mt-3" pendingLabel="Queuing retry…">Retry delivery</ActionSubmit>
              </form>
            )}
            {canCancel && (
              <form action={cancelCommunicationJob} className="rounded-xl bg-red-50 p-3">
                <input type="hidden" name="job_id" value={job.id} />
                <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                <input type="hidden" name="expected_version" value={job.version} />
                <p className="text-sm font-medium text-red-900">Cancel queued message</p>
                <p className="mt-1 text-xs text-red-800">Cancellation is final for this queue item. You can create a new reminder later.</p>
                <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg bg-white p-3 text-xs text-red-800">
                  <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                  <span>I confirm this message should not be delivered.</span>
                </label>
                <label className="mt-3 block text-xs font-medium text-red-900">Reason<textarea required minLength={3} maxLength={500} name="reason" className="mt-1 min-h-20 w-full rounded-lg border border-red-200 bg-white p-3 text-base font-normal" placeholder="Why should delivery stop?" /></label>
                <ActionSubmit tone="danger" className="mt-3" pendingLabel="Cancelling…">Cancel message</ActionSubmit>
              </form>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Delivery attempts" sub={`${attempts.length} recorded`} />
        <div className="mt-3 divide-y divide-[var(--rule-hairline)]">
          {attempts.map((attempt) => (
            <article key={attempt.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--ink-primary)]">Attempt {attempt.attempt_number}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">{formatMoment(attempt.started_at, contact?.timezone)}{attempt.provider ? ` · ${humanize(attempt.provider)}` : ""}</p>
                  {attempt.error_category && <p className="mt-1 text-xs text-red-700">{humanize(attempt.error_category)}</p>}
                </div>
                <StatusPill status={attempt.outcome} />
              </div>
            </article>
          ))}
          {!attempts.length && !loadError && (
            <p className="py-6 text-sm text-[var(--ink-secondary)]">No delivery attempts. This item has not been sent.</p>
          )}
        </div>
      </Card>
    </div>
  );
}

function Datum({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-[var(--ink-muted)]">{label}</dt><dd className="mt-0.5 break-words text-sm text-[var(--ink-primary)]">{value}</dd></div>;
}

function SourceLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="flex min-h-11 items-center justify-between rounded-xl border border-[var(--border-ring)] px-3 text-sm text-[var(--ink-primary)]"><span>{label}</span><span aria-hidden>→</span></Link>;
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "FAILED" || status === "SUPPRESSED" || status === "EXPIRED"
    ? "bg-red-50 text-red-700"
    : status === "SENT" || status === "DELIVERED" || status === "SUCCESS"
      ? "bg-green-50 text-green-800"
      : status === "CANCELLED" || status === "SKIPPED"
        ? "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]"
        : "bg-amber-50 text-amber-800";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${tone}`}>{humanize(status)}</span>;
}

function maskPhone(value: string | null) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Phone on file";
}

function maskEmail(value: string | null) {
  if (!value?.includes("@")) return "Email on file";
  return `•••@${value.split("@")[1]}`;
}

function formatMoment(value: string, timeZone = "America/New_York") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}

function humanize(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function channelLabel(value: string) {
  if (value === "SMS") return "SMS";
  if (value === "PUSH") return "Secure push";
  return "Email";
}
