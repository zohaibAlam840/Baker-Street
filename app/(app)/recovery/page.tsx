import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { can } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { reportProviderCallout, withdrawProviderCallout } from "@/lib/recovery/actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type QueueStatus = "OPEN" | "OFFERED" | "DEFERRED" | "RESOLVED" | "CLOSED";

interface RecoveryCaseRow {
  id: string;
  disruption_id: string;
  original_appointment_id: string;
  status: QueueStatus;
  priority: "CRITICAL" | "HIGH" | "NORMAL";
  requires_clinical_review: boolean;
  deferred_until: string | null;
  created_at: string;
}

interface DisruptionRow {
  id: string;
  disruption_type: "PROVIDER_CALLOUT" | "PATIENT_CANCELLATION";
  provider_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

interface VisitRow {
  id: string;
  service_id: string;
  start_time: string;
  end_time: string;
  scheduling_flexibility: string;
  patients: { timezone: string } | { timezone: string }[] | null;
}

const tabs = [
  { id: "open", label: "Open" },
  { id: "waiting", label: "Waiting" },
  { id: "resolved", label: "Resolved" },
] as const;

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; disruption?: string; page?: string; error?: string; notice?: string }>;
}) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  const canManage = can(session.role, "recovery.manage");
  const canReportOwn = can(session.role, "recovery.report_own");
  const canChooseProvider = can(session.role, "availability.manage");
  if (!canManage && !canReportOwn) redirect("/no-access?permission=recovery.view");

  const supabase = await createClient();
  const renderedAt = new Date().getTime();
  const providersResult = canChooseProvider
    ? await supabase
        .from("providers")
        .select("id, first_name, last_name, provider_type, timezone")
        .eq("status", "ACTIVE")
        .order("last_name")
        .limit(250)
    : { data: [], error: null };
  const ownProviderResult = !canChooseProvider && session.providerId
    ? await supabase.from("providers").select("id, timezone").eq("id", session.providerId).single()
    : { data: null, error: null };

  if (!canManage) {
    const { data: callouts, error } = await supabase
      .from("schedule_disruptions")
      .select("id, starts_at, ends_at, reason_category, status, created_at")
      .eq("disruption_type", "PROVIDER_CALLOUT")
      .eq("provider_id", session.providerId ?? "00000000-0000-0000-0000-000000000000")
      .order("starts_at", { ascending: false })
      .limit(30);
    return (
      <div className="space-y-5">
        <PageHeading providerMode />
        <Messages error={query.error ?? (error ? "Your callouts could not be loaded." : undefined)} notice={query.notice} />
        <CalloutForm providerId={session.providerId} providerTimezone={ownProviderResult.data?.timezone ?? undefined} />
        <Card>
          <CardHeader title="Your reported callouts" sub={`${callouts?.length ?? 0} recent`} />
          <div className="mt-4 divide-y divide-[var(--rule-hairline)]">
            {(callouts ?? []).map((callout) => {
              const eligibleForWithdrawal = ["OPEN", "RESOLVED"].includes(callout.status);
              const withdrawalWindowOpen = new Date(callout.starts_at).getTime() > renderedAt;
              return (
              <div key={callout.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--ink-primary)]">
                      {formatRange(callout.starts_at, callout.ends_at, ownProviderResult.data?.timezone)}
                    </p>
                    <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                      {humanize(callout.reason_category)}
                    </p>
                  </div>
                  <StatusPill status={callout.status} />
                </div>
                {eligibleForWithdrawal && (
                  <details className="mt-3 rounded-xl bg-[var(--surface-sunken)] p-3">
                    <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-[var(--ink-primary)]">Withdraw mistaken callout</summary>
                    <form action={withdrawProviderCallout} className="mt-3 space-y-3">
                      <input type="hidden" name="disruption_id" value={callout.id} />
                      <input type="hidden" name="return_to" value="/recovery" />
                      <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                      {!withdrawalWindowOpen && (
                        <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                          This callout has started. Future original visits can be restored, but already-started visits will remain cancelled for an accurate history.
                        </p>
                      )}
                      <Field label="Withdrawal reason">
                        <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Why should the original visits be restored?" />
                      </Field>
                      <label className="flex min-h-11 items-start gap-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">
                        <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                        <span>I confirm this withdraws the entire callout and restores only original visits that have not started.</span>
                      </label>
                      <ActionSubmit tone="danger" pendingLabel="Withdrawing…">Withdraw callout</ActionSubmit>
                    </form>
                  </details>
                )}
              </div>
              );
            })}
            {!callouts?.length && (
              <p className="py-6 text-sm text-[var(--ink-secondary)]">No callouts reported yet.</p>
            )}
          </div>
        </Card>
      </div>
    );
  }

  const activeTab = tabs.some((tab) => tab.id === query.tab) ? query.tab! : "open";
  const disruptionFilter = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.disruption ?? "")
    ? query.disruption!
    : null;
  const requestedPage = Number.parseInt(query.page ?? "1", 10);
  const currentPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = 50;
  const rangeStart = (currentPage - 1) * pageSize;
  const now = new Date(renderedAt);
  const nowIso = now.toISOString();

  const loadCases = async () => {
    let casesQuery = supabase
      .from("recovery_cases")
      .select("id, disruption_id, original_appointment_id, status, priority, requires_clinical_review, deferred_until, created_at")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false })
      .range(rangeStart, rangeStart + pageSize);
    casesQuery = activeTab === "open"
      ? casesQuery.or(`status.eq.OPEN,and(status.eq.DEFERRED,deferred_until.lte.${nowIso})`)
      : activeTab === "waiting"
        ? casesQuery.or(`status.eq.OFFERED,and(status.eq.DEFERRED,deferred_until.gt.${nowIso})`)
        : casesQuery.in("status", ["RESOLVED", "CLOSED"]);
    if (disruptionFilter) casesQuery = casesQuery.eq("disruption_id", disruptionFilter);
    return casesQuery;
  };

  let offerReconciliationError: { message: string } | null = null;

  // Reconcile bounded batches before reading the waiting queue. This avoids N+1
  // requests and keeps expired offers from hiding older work on later pages.
  if (activeTab === "waiting") {
    for (let pass = 0; pass < 5; pass += 1) {
      const maintenance = await supabase.rpc("expire_recovery_offer_queue", { p_limit: 100 });
      if (maintenance.error) {
        offerReconciliationError = maintenance.error;
        break;
      }
      const processed = Number((maintenance.data as { processed_count?: number } | null)?.processed_count ?? 0);
      if (processed < 100) break;
    }
  }

  const casesResult = await loadCases();
  const casesError = casesResult.error;
  const candidateCases = (casesResult.data ?? []) as RecoveryCaseRow[];
  const hasOlder = candidateCases.length > pageSize;
  const cases = candidateCases.slice(0, pageSize);

  const disruptionIds = [...new Set(cases.map((item) => item.disruption_id))];
  const appointmentIds = [...new Set(cases.map((item) => item.original_appointment_id))];
  const [disruptionsResult, visitsResult] = await Promise.all([
    disruptionIds.length
      ? supabase.from("schedule_disruptions").select("id, disruption_type, provider_id, starts_at, ends_at, status").in("id", disruptionIds)
      : Promise.resolve({ data: [] as DisruptionRow[], error: null }),
    appointmentIds.length
      ? supabase.from("appointments").select("id, service_id, start_time, end_time, scheduling_flexibility, patients!inner(timezone)").in("id", appointmentIds)
      : Promise.resolve({ data: [] as VisitRow[], error: null }),
  ]);
  const visits = (visitsResult.data ?? []) as unknown as VisitRow[];
  const serviceIds = [...new Set(visits.map((visit) => visit.service_id))];
  const servicesResult = serviceIds.length
    ? await supabase.from("services").select("id, service_name").in("id", serviceIds)
    : { data: [], error: null };
  const disruptionById = new Map(((disruptionsResult.data ?? []) as DisruptionRow[]).map((row) => [row.id, row]));
  const visitById = new Map(visits.map((row) => [row.id, row]));
  const serviceById = new Map((servicesResult.data ?? []).map((row) => [row.id, row.service_name]));
  const loadFailed = casesError || offerReconciliationError || disruptionsResult.error || visitsResult.error || servicesResult.error;

  return (
    <div className="space-y-5">
      <PageHeading />
      <Messages error={query.error ?? (loadFailed ? "The recovery queue could not be loaded." : undefined)} notice={query.notice} />

      {canChooseProvider || session.providerId ? (
        <CalloutForm
          providers={canChooseProvider ? providersResult.data ?? [] : undefined}
          providerId={session.providerId}
          providerTimezone={ownProviderResult.data?.timezone ?? undefined}
        />
      ) : (
        <Card>
          <CardHeader title="Provider callouts" sub="Clinician link required" />
          <p className="mt-3 text-sm text-[var(--ink-secondary)]">Your clinical account is not linked to a clinician record, so it cannot report a personal callout. A scheduler can still record one for you.</p>
        </Card>
      )}

      <section aria-labelledby="recovery-queue-title" className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 id="recovery-queue-title" className="text-base font-semibold text-[var(--ink-primary)]">Recovery queue</h2>
            <p className="text-xs text-[var(--ink-secondary)]">Only work in your permitted scope is shown.</p>
          </div>
          <span className="text-xs text-[var(--ink-muted)]">{cases.length}{hasOlder ? "+" : ""} on this page</span>
        </div>
        {disruptionFilter && (
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-[var(--brand-tint)] px-3 text-xs text-[var(--ink-secondary)]">
            <span>Showing visits affected by the selected callout.</span>
            <Link href="/recovery" className="shrink-0 font-medium text-[var(--brand)] underline underline-offset-4">Clear filter</Link>
          </div>
        )}
        <nav aria-label="Recovery status" className="grid grid-cols-3 rounded-xl bg-[var(--surface-sunken)] p-1">
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={`/recovery?tab=${tab.id}${disruptionFilter ? `&disruption=${disruptionFilter}` : ""}`}
              aria-current={activeTab === tab.id ? "page" : undefined}
              className={`grid min-h-11 place-items-center rounded-lg px-2 text-sm ${activeTab === tab.id ? "bg-[var(--surface-1)] font-medium text-[var(--ink-primary)] shadow-sm" : "text-[var(--ink-secondary)]"}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="grid gap-3 lg:grid-cols-2">
          {cases.map((recoveryCase) => {
            const disruption = disruptionById.get(recoveryCase.disruption_id);
            const visit = visitById.get(recoveryCase.original_appointment_id);
            const followUpDue = recoveryCase.status === "DEFERRED"
              && recoveryCase.deferred_until !== null
              && new Date(recoveryCase.deferred_until).getTime() <= now.getTime();
            return (
              <Link
                key={recoveryCase.id}
                href={`/recovery/${recoveryCase.id}`}
                className="card block min-h-11 p-4 transition-colors hover:border-[var(--brand-ring)] active:bg-[var(--surface-sunken)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">
                      {disruption?.disruption_type === "PROVIDER_CALLOUT" ? "Provider callout" : "Patient cancellation"}
                    </p>
                    <h3 className="mt-1 text-sm font-semibold text-[var(--ink-primary)]">
                      {visit ? serviceById.get(visit.service_id) ?? "Affected visit" : "Affected visit"}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                      {visit ? formatRange(visit.start_time, visit.end_time, patientTimezone(visit)) : "Visit details unavailable"}
                    </p>
                  </div>
                  <StatusPill status={followUpDue ? "FOLLOW_UP_DUE" : recoveryCase.status} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[0.6875rem] text-[var(--ink-secondary)]">
                  <span className="rounded-full bg-[var(--surface-sunken)] px-2.5 py-1">{humanize(recoveryCase.priority)} priority</span>
                  {visit?.scheduling_flexibility === "LOCKED" && <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">Locked visit</span>}
                  {recoveryCase.requires_clinical_review && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-800">Clinical review</span>}
                  {recoveryCase.status === "DEFERRED" && recoveryCase.deferred_until && (
                    <span className={`rounded-full px-2.5 py-1 ${followUpDue ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>
                      {followUpDue ? "Follow-up due" : "Deferred until"} {formatMoment(recoveryCase.deferred_until)}
                    </span>
                  )}
                </div>
                <p className="mt-3 text-xs font-medium text-[var(--brand)]">Open case →</p>
              </Link>
            );
          })}
        </div>
        {!cases.length && !loadFailed && (
          <div className="card px-4 py-10 text-center">
            <h3 className="text-sm font-semibold text-[var(--ink-primary)]">No cases in this view</h3>
            <p className="mt-1 text-sm text-[var(--ink-secondary)]">New disruptions will appear here automatically.</p>
          </div>
        )}
        {(currentPage > 1 || hasOlder) && (
          <nav aria-label="Recovery queue pages" className="flex items-center justify-between gap-3 pt-1">
            {currentPage > 1 ? (
              <Link href={queueHref(activeTab, currentPage - 1, disruptionFilter)} className="button-secondary min-h-11 px-4">Newer</Link>
            ) : <span />}
            <span className="text-xs text-[var(--ink-muted)]">Page {currentPage}</span>
            {hasOlder ? (
              <Link href={queueHref(activeTab, currentPage + 1, disruptionFilter)} className="button-secondary min-h-11 px-4">Older</Link>
            ) : <span />}
          </nav>
        )}
      </section>
    </div>
  );
}

function PageHeading({ providerMode = false }: { providerMode?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">Schedule recovery</p>
      <h1 className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
        {providerMode ? "Report a callout" : "Protect care when plans change"}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--ink-secondary)]">
        {providerMode
          ? "Report time you cannot work. Scheduling staff will handle affected visits without exposing patient details here."
          : "Record disruptions, find legal replacement visits, and track every response through resolution."}
      </p>
    </div>
  );
}

function Messages({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{notice}</p>}
    </>
  );
}

function CalloutForm({
  providers,
  providerId,
  providerTimezone,
}: {
  providers?: { id: string; first_name: string; last_name: string; provider_type: string; timezone: string }[];
  providerId?: string | null;
  providerTimezone?: string;
}) {
  return (
    <Card>
      <CardHeader title="Report provider callout" sub="Creates recovery cases for overlapping visits" />
      <form action={reportProviderCallout} className="mt-5 space-y-4">
        <input type="hidden" name="command_id" value={crypto.randomUUID()} />
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">Callout details</legend>
          {providers ? (
            <Field label="Clinician">
              <select required name="provider_id" className={inputClass} defaultValue="">
                <option value="" disabled>Choose clinician</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.last_name}, {provider.first_name} · {provider.provider_type} · {provider.timezone}</option>
                ))}
              </select>
            </Field>
          ) : (
            <input type="hidden" name="provider_id" value={providerId ?? ""} />
          )}
          <Field label="Reason category" hint="The private details do not belong in this form.">
            <select required name="reason_category" className={inputClass} defaultValue="">
              <option value="" disabled>Choose reason</option>
              <option value="ILLNESS">Illness</option>
              <option value="EMERGENCY">Emergency</option>
              <option value="PTO">PTO</option>
              <option value="TRAINING">Training</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Unavailable from">
            <input required name="start_time" type="datetime-local" className={inputClass} />
          </Field>
          <Field label="Unavailable until" hint={providerTimezone ? `Times use ${providerTimezone}.` : "Times use the selected clinician's timezone."}>
            <input required name="end_time" type="datetime-local" className={inputClass} />
          </Field>
        </fieldset>
        <Field label="Operational note" hint="Optional, 500 characters. Do not enter a diagnosis or other medical detail.">
          <textarea name="operational_note" maxLength={500} className={`${inputClass} min-h-20`} placeholder="Coverage or handoff information only" />
        </Field>
        <label className="flex min-h-11 items-start gap-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
          <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
          <span>I confirm this unavailable window is correct. Overlapping visits will be cancelled and moved into the recovery queue.</span>
        </label>
        <ActionSubmit pendingLabel="Recording callout…">Record callout</ActionSubmit>
      </form>
    </Card>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "RESOLVED" || status === "CLOSED" || status === "WITHDRAWN"
    ? "bg-green-50 text-green-800"
    : status === "OPEN" || status === "FOLLOW_UP_DUE"
      ? "bg-red-50 text-red-700"
      : "bg-amber-50 text-amber-800";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${tone}`}>{humanize(status)}</span>;
}

function queueHref(tab: string, page: number, disruption: string | null) {
  const params = new URLSearchParams({ tab });
  if (page > 1) params.set("page", String(page));
  if (disruption) params.set("disruption", disruption);
  return `/recovery?${params.toString()}`;
}

function formatMoment(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function humanize(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function patientTimezone(visit: VisitRow): string | undefined {
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  return patient?.timezone;
}

function formatRange(start: string, end: string, timeZone = process.env.SCHEDULING_TIMEZONE ?? "America/New_York") {
  const date = new Date(start);
  const endDate = new Date(end);
  const dateFormatter = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
  const partsFormatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const sameDay = partsFormatter.format(date) === partsFormatter.format(endDate);
  const day = dateFormatter.format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return sameDay ? `${day}, ${time.format(date)}–${time.format(endDate)}` : `${day} – ${dateFormatter.format(endDate)}`;
}
