import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { syncUpcomingReminders } from "@/lib/communications/actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type QueueTab = "attention" | "scheduled" | "complete";

interface CommunicationJobRow {
  id: string;
  patient_id: string;
  patient_contact_id: string;
  message_type: string;
  channel: string;
  status: string;
  scheduled_for: string;
  created_at: string;
  delivered_at: string | null;
  attempt_count: number;
  last_error_category: string | null;
}

interface ContactRow {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  timezone: string;
}

interface PatientRow {
  id: string;
  external_id: string | null;
}

const tabs: { id: QueueTab; label: string; statuses: string[] }[] = [
  { id: "attention", label: "Needs attention", statuses: ["FAILED", "SUPPRESSED", "EXPIRED"] },
  { id: "scheduled", label: "Queued", statuses: ["QUEUED", "PROCESSING", "SENT"] },
  { id: "complete", label: "History", statuses: ["DELIVERED", "CANCELLED"] },
];

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string; channel?: string; error?: string; notice?: string }>;
}) {
  const [session, query] = await Promise.all([requirePermission("communications.view"), searchParams]);
  const supabase = await createClient();
  const activeTab = tabs.some((tab) => tab.id === query.tab) ? query.tab as QueueTab : "attention";
  const activeStatuses = tabs.find((tab) => tab.id === activeTab)!.statuses;
  const channel = query.channel === "SMS" || query.channel === "EMAIL" ? query.channel : null;
  const parsedPage = Number.parseInt(query.page ?? "1", 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 1_000) : 1;
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  let jobsQuery = supabase
    .from("communication_jobs")
    .select("id,patient_id,patient_contact_id,message_type,channel,status,scheduled_for,created_at,delivered_at,attempt_count,last_error_category")
    .in("status", activeStatuses)
    .order(activeTab === "attention" ? "created_at" : "scheduled_for", { ascending: activeTab === "scheduled" })
    .range(offset, offset + pageSize);
  if (channel) jobsQuery = jobsQuery.eq("channel", channel);

  const jobsResult = await jobsQuery;
  const loadedJobs = (jobsResult.data ?? []) as CommunicationJobRow[];
  const hasOlder = loadedJobs.length > pageSize;
  const jobs = loadedJobs.slice(0, pageSize);
  const contactIds = [...new Set(jobs.map((job) => job.patient_contact_id))];
  const patientIds = [...new Set(jobs.map((job) => job.patient_id))];
  const [contactsResult, patientsResult] = await Promise.all([
    contactIds.length
      ? supabase.from("patient_contacts").select("id,name,relationship,phone,email,timezone").in("id", contactIds)
      : Promise.resolve({ data: [] as ContactRow[], error: null }),
    patientIds.length
      ? supabase.from("patients").select("id,external_id").in("id", patientIds)
      : Promise.resolve({ data: [] as PatientRow[], error: null }),
  ]);
  const contacts = new Map(((contactsResult.data ?? []) as ContactRow[]).map((row) => [row.id, row]));
  const patients = new Map(((patientsResult.data ?? []) as PatientRow[]).map((row) => [row.id, row]));
  const loadError = jobsResult.error || contactsResult.error || patientsResult.error;
  const canManage = can(session.role, "communications.manage");

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">Communications</p>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">Delivery work queue</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ink-secondary)]">
          Review appointment reminders and recovery notices without exposing clinical details in message previews.
        </p>
      </header>

      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}
      {loadError && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
          The communication queue could not be loaded. No messages were changed. Refresh and try again.
        </p>
      )}

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-medium">Delivery provider not connected</p>
        <p className="mt-1 text-xs leading-relaxed">
          This release records contacts, consent and queued work. It does not send SMS or email yet; connect an approved provider with a signed business associate agreement before enabling delivery.
        </p>
      </div>

      {canManage && (
        <details className="rounded-2xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-[var(--brand)]">
            Reconcile upcoming reminders
          </summary>
          <form action={syncUpcomingReminders} className="space-y-3 pb-4">
            <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
              Checks the next 31 days against the current appointment, primary recipient, consent, timezone, and quiet-hours records. Duplicate work is not created.
            </p>
            <label className="flex min-h-11 items-start gap-3 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">
              <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
              <span>I understand this may add valid queued reminders and cancel stale ones.</span>
            </label>
            <ActionSubmit pendingLabel="Reconciling reminders…">Reconcile now</ActionSubmit>
          </form>
        </details>
      )}

      <section aria-labelledby="queue-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="queue-title" className="text-base font-semibold text-[var(--ink-primary)]">Message queue</h2>
            <p className="text-xs text-[var(--ink-secondary)]">Only recipients and records in your permitted scope appear.</p>
          </div>
          <span className="text-xs text-[var(--ink-muted)]">{jobs.length}{hasOlder ? "+" : ""} on this page</span>
        </div>

        <nav aria-label="Communication status" className="grid grid-cols-3 rounded-xl bg-[var(--surface-sunken)] p-1">
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={queueHref(tab.id, 1, channel)}
              aria-current={activeTab === tab.id ? "page" : undefined}
              className={`grid min-h-11 place-items-center rounded-lg px-2 text-center text-xs sm:text-sm ${activeTab === tab.id ? "bg-[var(--surface-1)] font-medium text-[var(--ink-primary)] shadow-sm" : "text-[var(--ink-secondary)]"}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Filter by channel">
          {[
            { value: null, label: "All channels" },
            { value: "SMS", label: "SMS" },
            { value: "EMAIL", label: "Email" },
          ].map((filter) => (
            <Link
              key={filter.label}
              href={queueHref(activeTab, 1, filter.value)}
              aria-current={channel === filter.value ? "true" : undefined}
              className={`grid min-h-11 shrink-0 place-items-center rounded-full border px-4 text-xs ${channel === filter.value ? "border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--ink-primary)]" : "border-[var(--border-ring)] bg-[var(--surface-1)] text-[var(--ink-secondary)]"}`}
            >
              {filter.label}
            </Link>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {jobs.map((job) => {
            const contact = contacts.get(job.patient_contact_id);
            const patient = patients.get(job.patient_id);
            return (
              <Link
                key={job.id}
                href={`/communications/${job.id}`}
                className="card block min-h-11 p-4 transition-colors hover:border-[var(--brand-ring)] active:bg-[var(--surface-sunken)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">{humanize(job.message_type)}</p>
                    <h3 className="mt-1 truncate text-sm font-semibold text-[var(--ink-primary)]">
                      {contact?.name ?? "Recipient on file"}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                      {contact?.relationship ?? "Contact"} · {job.channel === "SMS" ? maskPhone(contact?.phone) : job.channel === "EMAIL" ? maskEmail(contact?.email) : "Secure push endpoint"}
                    </p>
                  </div>
                  <StatusPill status={job.status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-[var(--ink-muted)]">Scheduled</dt>
                    <dd className="mt-0.5 text-[var(--ink-primary)]">{formatMoment(job.scheduled_for, contact?.timezone)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--ink-muted)]">Patient record</dt>
                    <dd className="mt-0.5 text-[var(--ink-primary)]">{patient?.external_id ?? "Available in detail"}</dd>
                  </div>
                </dl>
                {job.status === "FAILED" && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    Delivery needs review{job.last_error_category ? ` · ${humanize(job.last_error_category)}` : ""}.
                  </p>
                )}
                <p className="mt-3 text-xs font-medium text-[var(--brand)]">Open delivery record →</p>
              </Link>
            );
          })}
        </div>

        {!jobs.length && !loadError && (
          <div className="card px-4 py-10 text-center">
            <h3 className="text-sm font-semibold text-[var(--ink-primary)]">Nothing in this view</h3>
            <p className="mt-1 text-sm text-[var(--ink-secondary)]">
              {activeTab === "attention" ? "Failed or blocked deliveries will appear here." : activeTab === "scheduled" ? "New reminders remain here until a delivery provider is connected." : "Completed and cancelled work will appear here."}
            </p>
          </div>
        )}

        {(page > 1 || hasOlder) && (
          <nav aria-label="Communication queue pages" className="flex items-center justify-between gap-3 pt-1">
            {page > 1 ? <Link href={queueHref(activeTab, page - 1, channel)} className="grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4 text-sm">Newer</Link> : <span />}
            <span className="text-xs text-[var(--ink-muted)]">Page {page}</span>
            {hasOlder ? <Link href={queueHref(activeTab, page + 1, channel)} className="grid min-h-11 place-items-center rounded-full border border-[var(--border-ring)] px-4 text-sm">Older</Link> : <span />}
          </nav>
        )}
      </section>

      {!canManage && (
        <Card>
          <CardHeader title="Read-only access" sub="Consent and queue changes stay with scheduling staff" />
          <p className="mt-3 text-sm text-[var(--ink-secondary)]">You can review delivery state for records in your scope, but you cannot change recipients or retry a message.</p>
        </Card>
      )}
    </div>
  );
}

function queueHref(tab: QueueTab, page: number, channel: string | null) {
  const params = new URLSearchParams({ tab });
  if (page > 1) params.set("page", String(page));
  if (channel) params.set("channel", channel);
  return `/communications?${params.toString()}`;
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "FAILED" || status === "SUPPRESSED" || status === "EXPIRED"
    ? "bg-red-50 text-red-700"
    : status === "SENT" || status === "DELIVERED"
      ? "bg-green-50 text-green-800"
      : status === "CANCELLED" || status === "SKIPPED"
        ? "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]"
        : "bg-amber-50 text-amber-800";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${tone}`}>{humanize(status)}</span>;
}

function maskPhone(value?: string | null) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Phone on file";
}

function maskEmail(value?: string | null) {
  if (!value?.includes("@")) return "Email on file";
  const [, domain] = value.split("@");
  return `•••@${domain}`;
}

function formatMoment(value: string, timeZone = "America/New_York") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}

function humanize(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
