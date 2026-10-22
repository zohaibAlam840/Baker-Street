import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { canAny } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { cancelProviderTimeOff, decideProviderTimeOff, requestProviderTimeOff } from "@/lib/availability/actions";
import { formatDateTimeLocal } from "@/lib/domain/time";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TimeOffStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

interface TimeOffRequest {
  id: string;
  provider_id: string;
  starts_at: string;
  ends_at: string;
  reason_category: "PTO" | "TRAINING" | "OTHER";
  request_note: string;
  status: TimeOffStatus;
  version: number;
  review_reason: string | null;
  reviewed_at: string | null;
  disruption_id: string | null;
  created_at: string;
  providers: {
    first_name: string;
    last_name: string;
    provider_type: string;
    timezone: string;
  } | {
    first_name: string;
    last_name: string;
    provider_type: string;
    timezone: string;
  }[];
}

export default async function TimeOffPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string; notice?: string }>;
}) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  const canRequest = canAny(session.role, ["availability.request"]);
  const canManage = canAny(session.role, ["availability.manage"]);
  if (!canRequest && !canManage) redirect("/no-access?permission=availability.request");

  const supabase = await createClient();
  const view = query.view === "history" ? "history" : "pending";
  let request = supabase
    .from("provider_time_off_requests")
    .select("id,provider_id,starts_at,ends_at,reason_category,request_note,status,version,review_reason,reviewed_at,disruption_id,created_at,providers!inner(first_name,last_name,provider_type,timezone)")
    .order("starts_at", { ascending: view === "pending" })
    .limit(100);
  request = view === "pending" ? request.eq("status", "PENDING") : request.neq("status", "PENDING");

  const [requestsResult, ownProviderResult] = await Promise.all([
    request,
    canRequest && session.providerId
      ? supabase.from("providers").select("id,first_name,last_name,timezone").eq("id", session.providerId).single()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (requestsResult.error) {
    throw new Error(`Time-off requests could not be loaded: ${requestsResult.error.message}`);
  }
  const rows = (requestsResult.data ?? []) as unknown as TimeOffRequest[];
  const ownProvider = ownProviderResult.data;
  const requestTimeZone = ownProvider?.timezone ?? process.env.SCHEDULING_TIMEZONE ?? "America/New_York";
  const renderedAt = new Date().getTime();
  const tomorrow = new Date(renderedAt + 24 * 60 * 60_000);
  const defaultStart = formatDateTimeLocal(tomorrow, requestTimeZone).slice(0, 11) + "09:00";
  const defaultEnd = formatDateTimeLocal(tomorrow, requestTimeZone).slice(0, 11) + "17:00";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">Planned time off</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
            Providers request planned absences here. Scheduler approval applies the exact window and sends affected visits into schedule recovery.
          </p>
        </div>
        <div className="flex rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] p-1 text-xs">
          <Link href="/time-off" className={`rounded-full px-3 py-2 ${view === "pending" ? "bg-[var(--brand)] text-white" : "text-[var(--ink-secondary)]"}`}>Pending</Link>
          <Link href="/time-off?view=history" className={`rounded-full px-3 py-2 ${view === "history" ? "bg-[var(--brand)] text-white" : "text-[var(--ink-secondary)]"}`}>History</Link>
        </div>
      </div>

      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}

      {canRequest && ownProvider && (
        <Card>
          <CardHeader title="Request time off" sub={`${ownProvider.first_name} ${ownProvider.last_name} · ${requestTimeZone}`} />
          <form action={requestProviderTimeOff} className="mt-4 space-y-4">
            <input type="hidden" name="command_id" value={crypto.randomUUID()} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts"><input required name="start_time" type="datetime-local" className={inputClass} defaultValue={defaultStart} /></Field>
              <Field label="Ends"><input required name="end_time" type="datetime-local" className={inputClass} defaultValue={defaultEnd} /></Field>
            </div>
            <Field label="Reason category">
              <select required name="reason_category" className={inputClass} defaultValue="PTO">
                <option value="PTO">Paid time off</option>
                <option value="TRAINING">Training</option>
                <option value="OTHER">Other planned absence</option>
              </select>
            </Field>
            <Field label="Request note" hint="Keep this operational; do not include patient information.">
              <textarea required minLength={3} maxLength={500} name="request_note" className={`${inputClass} min-h-24`} placeholder="Dates, coverage context, or other details for the scheduler" />
            </Field>
            <label className="flex min-h-11 items-start gap-3 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">
              <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
              <span>I reviewed the dates in {requestTimeZone}. This is a request and does not change the schedule until approved.</span>
            </label>
            <ActionSubmit pendingLabel="Submitting request…">Submit for review</ActionSubmit>
          </form>
        </Card>
      )}

      {canRequest && !ownProvider && (
        <Card>
          <CardHeader title="Clinician link required" />
          <p className="mt-3 text-sm text-[var(--ink-secondary)]">Your account must be linked to your clinician record before you can request time off.</p>
        </Card>
      )}

      {canRequest && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Need to report an illness or emergency that should affect the schedule now? Use <Link href="/recovery" className="font-medium underline underline-offset-4">Report a callout</Link> instead.
        </p>
      )}

      <section aria-labelledby="time-off-queue-title" className="space-y-3">
        <div>
          <h2 id="time-off-queue-title" className="text-base font-semibold text-[var(--ink-primary)]">{canManage ? "Time-off review queue" : "Your requests"}</h2>
          <p className="text-xs text-[var(--ink-secondary)]">{view === "pending" ? `${rows.length} awaiting a decision` : `${rows.length} decided or withdrawn`}</p>
        </div>

        <div className="grid gap-4">
          {rows.map((row) => {
            const provider = one(row.providers);
            const timezone = provider?.timezone ?? "America/New_York";
            return (
              <Card key={row.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">{humanize(row.reason_category)}</p>
                    <h3 className="mt-1 text-base font-semibold text-[var(--ink-primary)]">{provider ? `${provider.first_name} ${provider.last_name}` : "Clinician"}</h3>
                    <p className="mt-1 text-xs text-[var(--ink-secondary)]">{provider?.provider_type ? humanize(provider.provider_type) : "Provider"} · requested {new Date(row.created_at).toLocaleString()}</p>
                  </div>
                  <StatusBadge status={row.status} />
                </div>

                <div className="mt-4 rounded-xl bg-[var(--surface-sunken)] p-4">
                  <p className="text-xs text-[var(--ink-muted)]">Requested window · {timezone}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--ink-primary)]">{formatRange(row.starts_at, row.ends_at, timezone)}</p>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-[var(--ink-secondary)]"><span className="font-medium text-[var(--ink-primary)]">Request note:</span> {row.request_note}</p>

                {row.status === "PENDING" && canManage && (
                  <form action={decideProviderTimeOff} className="mt-5 space-y-3 border-t border-[var(--rule-hairline)] pt-5">
                    <input type="hidden" name="request_id" value={row.id} />
                    <input type="hidden" name="expected_version" value={row.version} />
                    <Field label="Decision reason" hint="This reason is retained in the permanent audit history.">
                      <textarea required minLength={3} maxLength={1000} name="reason" className={`${inputClass} min-h-24`} placeholder="Document why this window is approved or rejected" />
                    </Field>
                    <label className="flex min-h-11 items-start gap-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">
                      <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                      <span>I reviewed the exact window. Approval immediately cancels overlapping active visits and creates recovery work.</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <ActionSubmit name="decision" value="APPROVED" tone="danger" pendingLabel="Approving…">Approve and apply</ActionSubmit>
                      <ActionSubmit name="decision" value="REJECTED" tone="secondary" pendingLabel="Rejecting…">Reject request</ActionSubmit>
                    </div>
                  </form>
                )}

                {row.status === "PENDING" && canRequest && (
                  <details className="mt-4 rounded-xl border border-[var(--rule-hairline)] p-3">
                    <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-[var(--ink-primary)]">Withdraw this pending request</summary>
                    <form action={cancelProviderTimeOff} className="mt-3 space-y-3">
                      <input type="hidden" name="request_id" value={row.id} />
                      <input type="hidden" name="expected_version" value={row.version} />
                      <Field label="Withdrawal reason"><textarea required minLength={3} maxLength={1000} name="reason" className={`${inputClass} min-h-20`} /></Field>
                      <label className="flex min-h-11 items-start gap-3 text-xs text-[var(--ink-secondary)]">
                        <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                        <span>I confirm this pending request should be withdrawn.</span>
                      </label>
                      <ActionSubmit tone="danger" pendingLabel="Withdrawing…">Withdraw request</ActionSubmit>
                    </form>
                  </details>
                )}

                {row.status !== "PENDING" && row.review_reason && (
                  <div className="mt-4 rounded-xl border border-[var(--rule-hairline)] p-3 text-sm text-[var(--ink-secondary)]">
                    <p><span className="font-medium text-[var(--ink-primary)]">Decision reason:</span> {row.review_reason}</p>
                    {row.reviewed_at && <p className="mt-1 text-xs text-[var(--ink-muted)]">Updated {new Date(row.reviewed_at).toLocaleString()}</p>}
                  </div>
                )}
                {row.disruption_id && <Link href={`/recovery?disruption=${row.disruption_id}`} className="mt-4 inline-block text-xs font-medium text-[var(--brand)] underline underline-offset-4">Open affected recovery work</Link>}
              </Card>
            );
          })}
        </div>

        {rows.length === 0 && (
          <Card>
            <CardHeader title={view === "pending" ? "No time-off requests awaiting review" : "No request history yet"} />
            <p className="mt-3 text-sm text-[var(--ink-secondary)]">{view === "pending" ? "New provider requests will appear here." : "Approved, rejected, and withdrawn requests will appear here."}</p>
          </Card>
        )}
      </section>
    </div>
  );
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function humanize(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatRange(start: string, end: string, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameDate = date.format(startDate) === date.format(endDate);
  return sameDate
    ? `${date.format(startDate)} · ${time.format(startDate)}–${time.format(endDate)}`
    : `${date.format(startDate)} ${time.format(startDate)} – ${date.format(endDate)} ${time.format(endDate)}`;
}

function StatusBadge({ status }: { status: TimeOffStatus }) {
  const label = { PENDING: "Needs review", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Withdrawn" }[status];
  const tone = status === "PENDING"
    ? "bg-amber-50 text-amber-900"
    : status === "APPROVED"
      ? "bg-emerald-50 text-emerald-800"
      : "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]";
  return <span className={`rounded-full px-3 py-1 text-xs font-medium ${tone}`}>{label}</span>;
}
