import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { canAny } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { decideAppointmentReduction } from "@/lib/scheduling/reductionActions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface ReductionRequest {
  id: string;
  appointment_id: string;
  request_reason: string;
  proposed_start_time: string;
  proposed_end_time: string;
  source_start_time: string;
  source_end_time: string;
  source_week_start: string;
  scheduled_minutes_before: number;
  scheduled_minutes_after: number;
  target_minutes: number | null;
  required_service: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED" | "STALE";
  version: number;
  review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  patients: { first_name: string; last_name: string; timezone: string } | { first_name: string; last_name: string; timezone: string }[];
  services: { service_name: string } | { service_name: string }[];
}

export default async function ReductionReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string; notice?: string }>;
}) {
  const session = await requireSession();
  if (!canAny(session.role, ["schedule.book", "schedule.approve_reduction"])) {
    redirect("/no-access");
  }
  const query = await searchParams;
  const view = query.view === "history" ? "history" : "pending";
  const canDecide = canAny(session.role, ["schedule.approve_reduction"]);
  const supabase = await createClient();
  let request = supabase
    .from("appointment_reduction_requests")
    .select("id,appointment_id,request_reason,proposed_start_time,proposed_end_time,source_start_time,source_end_time,source_week_start,scheduled_minutes_before,scheduled_minutes_after,target_minutes,required_service,status,version,review_reason,created_at,reviewed_at,patients!inner(first_name,last_name,timezone),services!inner(service_name)")
    .order("created_at", { ascending: false })
    .limit(100);
  request = view === "pending"
    ? request.eq("status", "PENDING")
    : request.neq("status", "PENDING");
  const { data, error } = await request;
  if (error) throw new Error(`Clinical reduction requests could not be loaded: ${error.message}`);
  const rows = (data ?? []) as unknown as ReductionRequest[];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">Clinical reduction review</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
            Planned edits appear here only when they would lower a patient&apos;s service below its active weekly target or remove the last visit for a required service.
          </p>
        </div>
        <div className="flex rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] p-1 text-xs">
          <Link href="/reductions" className={`rounded-full px-3 py-2 ${view === "pending" ? "bg-[var(--brand)] text-white" : "text-[var(--ink-secondary)]"}`}>Pending</Link>
          <Link href="/reductions?view=history" className={`rounded-full px-3 py-2 ${view === "history" ? "bg-[var(--brand)] text-white" : "text-[var(--ink-secondary)]"}`}>History</Link>
        </div>
      </div>

      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}

      {!canDecide && view === "pending" && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          You can track submitted requests here. A clinical supervisor assigned to the patient must make the decision.
        </p>
      )}

      <div className="grid gap-4">
        {rows.map((row) => {
          const patient = one(row.patients);
          const service = one(row.services);
          const timezone = patient?.timezone ?? "America/New_York";
          const decrease = row.scheduled_minutes_before - row.scheduled_minutes_after;
          return (
            <Card key={row.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">{service?.service_name ?? "Service"}</p>
                  <h2 className="mt-1 text-base font-semibold text-[var(--ink-primary)]">
                    {patient ? `${patient.first_name} ${patient.last_name}` : "Patient"}
                  </h2>
                  <p className="mt-1 text-xs text-[var(--ink-secondary)]">Week of {row.source_week_start} · requested {new Date(row.created_at).toLocaleString()}</p>
                </div>
                <StatusBadge status={row.status} />
              </div>

              <dl className="mt-4 grid gap-3 rounded-xl bg-[var(--surface-sunken)] p-4 sm:grid-cols-4">
                <Metric label="Before" value={hours(row.scheduled_minutes_before)} />
                <Metric label="Proposed" value={hours(row.scheduled_minutes_after)} />
                <Metric label="Reduction" value={hours(decrease)} />
                <Metric label="Clinical target" value={row.target_minutes === null ? (row.required_service ? "Required" : "Not set") : hours(row.target_minutes)} />
              </dl>

              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-xl border border-[var(--rule-hairline)] p-3">
                  <p className="text-xs text-[var(--ink-muted)]">Current appointment</p>
                  <p className="mt-1 font-medium">{formatRange(row.source_start_time, row.source_end_time, timezone)}</p>
                </div>
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
                  <p className="text-xs text-amber-800">Proposed appointment</p>
                  <p className="mt-1 font-medium">{formatRange(row.proposed_start_time, row.proposed_end_time, timezone)}</p>
                </div>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-[var(--ink-secondary)]"><span className="font-medium text-[var(--ink-primary)]">Request reason:</span> {row.request_reason}</p>

              {row.status === "PENDING" && canDecide && (
                <form action={decideAppointmentReduction} className="mt-5 space-y-3 border-t border-[var(--rule-hairline)] pt-5">
                  <input type="hidden" name="request_id" value={row.id} />
                  <input type="hidden" name="expected_version" value={row.version} />
                  <Field label="Clinical decision reason" hint="This reason is retained in the permanent audit history.">
                    <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-24`} placeholder="Document why the reduction is or is not clinically appropriate" />
                  </Field>
                  <label className="flex min-h-11 items-start gap-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">
                    <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                    <span>I reviewed the weekly clinical target and the exact before-and-after appointment times.</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <ActionSubmit name="decision" value="APPROVED" tone="danger" pendingLabel="Approving reduction…">Approve reduction</ActionSubmit>
                    <ActionSubmit name="decision" value="REJECTED" tone="secondary" pendingLabel="Rejecting request…">Reject · keep appointment</ActionSubmit>
                  </div>
                </form>
              )}

              {row.status !== "PENDING" && row.review_reason && (
                <div className="mt-4 rounded-xl border border-[var(--rule-hairline)] p-3 text-sm text-[var(--ink-secondary)]">
                  <p><span className="font-medium text-[var(--ink-primary)]">Decision reason:</span> {row.review_reason}</p>
                  {row.reviewed_at && <p className="mt-1 text-xs text-[var(--ink-muted)]">Decided {new Date(row.reviewed_at).toLocaleString()}</p>}
                </div>
              )}

              <Link href={`/appointments/${row.appointment_id}`} className="mt-4 inline-block text-xs font-medium text-[var(--brand)] underline underline-offset-4">Open appointment</Link>
            </Card>
          );
        })}
      </div>

      {rows.length === 0 && (
        <Card>
          <CardHeader title={view === "pending" ? "No reductions awaiting review" : "No decided reductions yet"} />
          <p className="mt-3 text-sm text-[var(--ink-secondary)]">
            {view === "pending" ? "Routine appointment changes continue immediately; only clinically material reductions enter this queue." : "Approved, rejected, and stale requests will appear here."}
          </p>
        </Card>
      )}
    </div>
  );
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function hours(minutes: number) {
  return `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 2 })}h`;
}

function formatRange(start: string, end: string, timeZone: string) {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(start));
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  return `${date} · ${time.format(new Date(start))}–${time.format(new Date(end))}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-[var(--ink-muted)]">{label}</dt><dd className="mt-1 text-base font-semibold tabular-nums text-[var(--ink-primary)]">{value}</dd></div>;
}

function StatusBadge({ status }: { status: ReductionRequest["status"] }) {
  const label = { PENDING: "Needs review", APPROVED: "Approved", REJECTED: "Rejected", STALE: "Stale" }[status];
  const tone = status === "PENDING" ? "bg-amber-50 text-amber-900" : status === "APPROVED" ? "bg-red-50 text-red-800" : "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]";
  return <span className={`rounded-full px-3 py-1 text-xs font-medium ${tone}`}>{label}</span>;
}
