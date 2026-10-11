import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { queueRecoveryMessage } from "@/lib/communications/actions";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTimeLocal } from "@/lib/domain/time";
import {
  createRecoveryOffer,
  loadRecoverySuggestions,
  releaseLockedRecoveryCase,
  respondRecoveryOffer,
  setRecoveryCaseState,
  withdrawProviderCallout,
} from "@/lib/recovery/actions";
import type { RecoveryOption } from "@/lib/recovery/types";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface CaseRow {
  id: string;
  patient_id: string;
  disruption_id: string;
  original_appointment_id: string;
  replacement_appointment_id: string | null;
  status: "OPEN" | "OFFERED" | "DEFERRED" | "RESOLVED" | "CLOSED";
  priority: "CRITICAL" | "HIGH" | "NORMAL";
  requires_clinical_review: boolean;
  locked_override_approved: boolean;
  deferred_until: string | null;
  resolution_code: string | null;
  decision_reason: string | null;
  version: number;
  created_at: string;
  resolved_at: string | null;
}

interface DisruptionRow {
  id: string;
  disruption_type: "PROVIDER_CALLOUT" | "PATIENT_CANCELLATION";
  provider_id: string | null;
  starts_at: string;
  ends_at: string;
  reason_category: string;
  status: string;
  created_at: string;
}

interface OriginalVisitRow {
  id: string;
  patient_id: string;
  service_id: string;
  provider_id: string | null;
  location_id: string | null;
  start_time: string;
  end_time: string;
  scheduling_flexibility: string;
  status: string;
  patients: { first_name: string; last_name: string; timezone: string } | { first_name: string; last_name: string; timezone: string }[] | null;
  services: { service_name: string } | { service_name: string }[] | null;
}

interface OfferRow {
  id: string;
  candidate_key: string;
  proposed_provider_id: string;
  proposed_location_id: string | null;
  proposed_start_time: string;
  proposed_end_time: string;
  proposed_telehealth: boolean;
  proposed_resource_ids: string[] | null;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "WITHDRAWN";
  expires_at: string;
  response_reason: string | null;
  created_at: string;
  responded_at: string | null;
}

interface RecoveryContact {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  push_endpoint: string | null;
  timezone: string;
}

interface RecoveryConsent {
  patient_contact_id: string;
  channel: "SMS" | "EMAIL" | "PUSH";
  status: "GRANTED" | "REVOKED";
}

interface RecoveryCommunication {
  id: string;
  recovery_offer_id: string | null;
  patient_contact_id: string;
  channel: "SMS" | "EMAIL" | "PUSH";
  status: string;
  scheduled_for: string;
}

export default async function RecoveryCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [session, { caseId }, query] = await Promise.all([
    requirePermission("recovery.view"),
    params,
    searchParams,
  ]);
  const supabase = await createClient();
  const { data: visibleCase, error: visibleCaseError } = await supabase
    .from("recovery_cases")
    .select("id")
    .eq("id", caseId)
    .single();
  if (visibleCaseError || !visibleCase) notFound();
  const { error: expiryError } = await supabase.rpc("expire_recovery_offers", {
    p_case_id: caseId,
  });
  if (expiryError) throw new Error("Expired recovery offers could not be reconciled safely.");
  const [{ data: rawCase, error: caseError }, suggestions] = await Promise.all([
    supabase
      .from("recovery_cases")
      .select("id, patient_id, disruption_id, original_appointment_id, replacement_appointment_id, status, priority, requires_clinical_review, locked_override_approved, deferred_until, resolution_code, decision_reason, version, created_at, resolved_at")
      .eq("id", caseId)
      .single(),
    loadRecoverySuggestions(caseId),
  ]);
  if (caseError || !rawCase) notFound();
  if (!suggestions) notFound();
  const recoveryCase = rawCase as CaseRow;

  const [{ data: rawDisruption }, { data: rawOriginal }, { data: rawOffers, error: offersError }] = await Promise.all([
    supabase
      .from("schedule_disruptions")
      .select("id, disruption_type, provider_id, starts_at, ends_at, reason_category, status, created_at")
      .eq("id", recoveryCase.disruption_id)
      .single(),
    supabase
      .from("appointments")
      .select("id, patient_id, service_id, provider_id, location_id, start_time, end_time, scheduling_flexibility, status, patients(first_name,last_name,timezone), services(service_name)")
      .eq("id", recoveryCase.original_appointment_id)
      .single(),
    supabase
      .from("recovery_offers")
      .select("id, candidate_key, proposed_provider_id, proposed_location_id, proposed_start_time, proposed_end_time, proposed_telehealth, proposed_resource_ids, status, expires_at, response_reason, created_at, responded_at")
      .eq("recovery_case_id", caseId)
      .order("created_at", { ascending: false }),
  ]);
  if (!rawDisruption || !rawOriginal) notFound();
  const disruption = rawDisruption as DisruptionRow;
  const original = rawOriginal as unknown as OriginalVisitRow;
  const offers = (rawOffers ?? []) as OfferRow[];
  const renderedAt = new Date().getTime();
  const earliestOfferableStart = renderedAt + 7 * 60_000;
  const options = (suggestions.result.appointments
    .find((item) => item.appointment_id === recoveryCase.original_appointment_id)?.options ?? [])
    .filter((option) => new Date(option.start_time).getTime() > earliestOfferableStart);

  const referencedProviderIds = [...new Set([
    original.provider_id,
    ...offers.map((offer) => offer.proposed_provider_id),
    ...options.map((option) => option.provider_id),
  ].filter((id): id is string => Boolean(id)))];
  const referencedLocationIds = [...new Set([
    original.location_id,
    ...offers.map((offer) => offer.proposed_location_id),
    ...options.map((option) => option.location_id),
  ].filter((id): id is string => Boolean(id)))];
  const [providersResult, locationsResult] = await Promise.all([
    referencedProviderIds.length
      ? supabase.from("providers").select("id, first_name, last_name").in("id", referencedProviderIds)
      : Promise.resolve({ data: [], error: null }),
    referencedLocationIds.length
      ? supabase.from("locations").select("id, name").in("id", referencedLocationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const canViewCommunications = can(session.role, "communications.view");
  const canQueueCommunications = can(session.role, "communications.queue");
  const relationshipDate = new Date(renderedAt).toISOString().slice(0, 10);
  const contactsResult = canViewCommunications
    ? await supabase
        .from("patient_contacts")
        .select("id,name,relationship,phone,email,push_endpoint,timezone")
        .eq("patient_id", recoveryCase.patient_id)
        .eq("active", true)
        .eq("authorized_to_receive_information", true)
        .not("relationship_verified_at", "is", null)
        .lte("relationship_effective_start", relationshipDate)
        .or(`relationship_effective_end.is.null,relationship_effective_end.gte.${relationshipDate}`)
        .order("is_primary", { ascending: false })
    : { data: [] as RecoveryContact[], error: null };
  const contacts = (contactsResult.data ?? []) as RecoveryContact[];
  const [consentsResult, communicationsResult] = await Promise.all([
    canQueueCommunications && contacts.length
      ? supabase.from("communication_consents").select("patient_contact_id,channel,status").in("patient_contact_id", contacts.map((contact) => contact.id)).eq("status", "GRANTED")
      : Promise.resolve({ data: [] as RecoveryConsent[], error: null }),
    canViewCommunications
      ? supabase.from("communication_jobs").select("id,recovery_offer_id,patient_contact_id,channel,status,scheduled_for").eq("recovery_case_id", caseId).order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] as RecoveryCommunication[], error: null }),
  ]);
  const consents = (consentsResult.data ?? []) as RecoveryConsent[];
  const communications = (communicationsResult.data ?? []) as RecoveryCommunication[];
  const providerNames = new Map((providersResult.data ?? []).map((row) => [row.id, `${row.first_name} ${row.last_name}`]));
  const locationNames = new Map((locationsResult.data ?? []).map((row) => [row.id, row.name]));
  const patient = Array.isArray(original.patients) ? original.patients[0] : original.patients;
  const service = Array.isArray(original.services) ? original.services[0] : original.services;
  const timezone = patient?.timezone ?? "America/New_York";
  const active = ["OPEN", "OFFERED", "DEFERRED"].includes(recoveryCase.status);
  const actionsReady = !offersError;
  const canApproveProtected = can(session.role, "schedule.approve_reduction");
  const canWithdrawCallout = can(session.role, "availability.manage")
    || (Boolean(session.providerId) && disruption.provider_id === session.providerId);
  const withdrawalWindowOpen = new Date(disruption.starts_at).getTime() > renderedAt;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/recovery" className="text-xs text-[var(--ink-secondary)] underline underline-offset-4">← Recovery queue</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">
              {disruption.disruption_type === "PROVIDER_CALLOUT" ? "Provider callout" : "Patient cancellation"}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">Recover affected visit</h1>
            <p className="mt-1 text-sm text-[var(--ink-secondary)]">
              Case version {recoveryCase.version} · {humanize(recoveryCase.priority)} priority
            </p>
          </div>
          <StatusPill status={recoveryCase.status} />
        </div>
      </div>

      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}
      {offersError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">Offer history could not be loaded. No changes were made.</p>}
      {(contactsResult.error || consentsResult.error || communicationsResult.error) && canViewCommunications && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">Recipients or delivery history could not be verified. Outreach and response actions are unavailable until you refresh.</p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader title="Affected visit" sub={original.status} />
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <Detail label="Patient" value={patient ? `${patient.first_name} ${patient.last_name}` : "Unavailable"} />
            <Detail label="Service" value={service?.service_name ?? "Unavailable"} />
            <Detail label="Original clinician" value={original.provider_id ? providerNames.get(original.provider_id) ?? "Clinician" : "Unassigned"} />
            <Detail label="Original time" value={formatRange(original.start_time, original.end_time, timezone)} />
            <Detail label="Location" value={original.location_id ? locationNames.get(original.location_id) ?? "Location" : "Telehealth / none"} />
            <Detail label="Protection" value={humanize(original.scheduling_flexibility)} />
          </dl>
        </Card>
        <Card>
          <CardHeader title="Disruption" sub={humanize(disruption.status)} />
          <dl className="mt-4 space-y-3">
            <Detail label="Category" value={humanize(disruption.reason_category)} compact />
            <Detail label="Window" value={formatRange(disruption.starts_at, disruption.ends_at, timezone)} compact />
            {recoveryCase.deferred_until && <Detail label="Deferred until" value={formatInstant(recoveryCase.deferred_until, timezone)} compact />}
            {recoveryCase.resolution_code && <Detail label="Resolution" value={humanize(recoveryCase.resolution_code)} compact />}
          </dl>
        </Card>
      </div>

      {active && recoveryCase.requires_clinical_review && !canApproveProtected && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          A clinical supervisor must record acceptance because this visit is protected or its recovery affects required care.
        </div>
      )}

      {active && original.scheduling_flexibility === "LOCKED" && !recoveryCase.locked_override_approved && (
        canApproveProtected ? (
          <Card>
            <CardHeader title="Release locked visit" sub="Clinical approval is required before replacement options can be generated" />
            <form action={releaseLockedRecoveryCase} className="mt-4 space-y-3">
              <input type="hidden" name="case_id" value={caseId} />
              <input type="hidden" name="expected_version" value={recoveryCase.version} />
              <Field label="Clinical reason">
                <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Why may this locked visit enter protected recovery?" />
              </Field>
              <label className="flex min-h-11 items-start gap-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                <span>I approve releasing this locked visit for protected replacement planning. The original lock remains in the audit history.</span>
              </label>
              <ActionSubmit pendingLabel="Recording clinical approval…">Release for recovery</ActionSubmit>
            </form>
          </Card>
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            This locked visit cannot be moved until a clinical supervisor releases it for protected recovery.
          </div>
        )
      )}

      {recoveryCase.locked_override_approved && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          A clinical supervisor released this locked visit for protected recovery. The approval is preserved in the audit trail.
        </div>
      )}

      {active && actionsReady && (
        <section aria-labelledby="safe-options-title" className="space-y-3">
          <div>
            <h2 id="safe-options-title" className="text-base font-semibold text-[var(--ink-primary)]">Legal replacement options</h2>
            <p className="mt-1 text-xs text-[var(--ink-secondary)]">Recomputed from current authorizations, credentials, availability, travel, rooms, and conflicts.</p>
          </div>
          {options.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {options.map((option, index) => (
                <RecoveryOptionCard
                  key={option.id}
                  option={option}
                  rank={index + 1}
                  caseId={caseId}
                  version={recoveryCase.version}
                  providerName={providerNames.get(option.provider_id) ?? "Qualified clinician"}
                  locationName={option.location_id ? locationNames.get(option.location_id) ?? "Approved location" : "Telehealth"}
                  timezone={timezone}
                  renderedAt={renderedAt}
                />
              ))}
            </div>
          ) : (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[var(--ink-primary)]">No safe automatic option</h3>
              <p className="mt-1 text-sm text-[var(--ink-secondary)]">
                {original.scheduling_flexibility === "LOCKED" && !recoveryCase.locked_override_approved
                  ? "The visit is locked and was preserved for explicit human review."
                  : suggestions.result.explanations[0]?.message ?? "No legal replacement is available in this scheduling window."}
              </p>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="offers-title" className="space-y-3">
        <div>
          <h2 id="offers-title" className="text-base font-semibold text-[var(--ink-primary)]">Offer history</h2>
          <p className="mt-1 text-xs text-[var(--ink-secondary)]">Tie every response to a concrete contact and either a delivered message or a verified manual conversation.</p>
        </div>
        <div className="space-y-3">
          {offers.map((offer) => {
            const pending = offer.status === "PENDING" && new Date(offer.expires_at).getTime() > renderedAt;
            const canAccept = !recoveryCase.requires_clinical_review || canApproveProtected;
            const offerCommunications = communications.filter((job) => job.recovery_offer_id === offer.id);
            const deliveredCommunications = offerCommunications.filter((job) =>
              job.status === "DELIVERED" && contacts.some((contact) => contact.id === job.patient_contact_id));
            const provenanceOptions = [
              ...deliveredCommunications.map((job) => ({
                value: `DELIVERED:${job.id}`,
                label: `${job.channel} delivered to ${contacts.find((contact) => contact.id === job.patient_contact_id)?.name ?? "recorded contact"}`,
              })),
              ...contacts.flatMap((contact) => [
                ...(contact.phone ? [{ value: `MANUAL_PHONE:${contact.id}`, label: `Phone conversation with ${contact.name}` }] : []),
                { value: `IN_PERSON:${contact.id}`, label: `In-person response from ${contact.name}` },
              ]),
            ];
            return (
              <Card key={offer.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--ink-primary)]">{providerNames.get(offer.proposed_provider_id) ?? "Qualified clinician"}</h3>
                    <p className="mt-1 text-xs text-[var(--ink-secondary)]">{formatRange(offer.proposed_start_time, offer.proposed_end_time, timezone)} · {offer.proposed_location_id ? locationNames.get(offer.proposed_location_id) ?? "Approved location" : "Telehealth"}</p>
                    <p className="mt-1 text-[0.6875rem] text-[var(--ink-muted)]">Expires {formatInstant(offer.expires_at, timezone)}</p>
                  </div>
                  <StatusPill status={pending ? "PENDING" : offer.status === "PENDING" ? "EXPIRED" : offer.status} />
                </div>
                {offerCommunications.length > 0 && (
                  <div className="mt-3 space-y-2 rounded-xl bg-[var(--surface-sunken)] p-3">
                    <p className="text-xs font-medium text-[var(--ink-primary)]">Outreach history</p>
                    {offerCommunications.map((job) => (
                      <Link key={job.id} href={`/communications/${job.id}`} className="flex min-h-11 items-center justify-between gap-3 text-xs text-[var(--ink-secondary)] underline underline-offset-4">
                        <span>{job.channel} · {contacts.find((contact) => contact.id === job.patient_contact_id)?.name ?? "Recorded contact"}</span>
                        <span>{humanize(job.status)} →</span>
                      </Link>
                    ))}
                  </div>
                )}
                {pending && active && canQueueCommunications && !contactsResult.error && !consentsResult.error && new Date(offer.expires_at).getTime() > renderedAt + 2 * 60_000 && (
                  <details className="mt-3 rounded-xl border border-[var(--border-ring)] px-3">
                    <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-[var(--brand)]">Queue privacy-safe offer message</summary>
                    <div className="space-y-2 pb-3">
                      {consents.flatMap((consent) => {
                        const contact = contacts.find((item) => item.id === consent.patient_contact_id);
                        const configured = contact && (consent.channel === "SMS" ? contact.phone : consent.channel === "EMAIL" ? contact.email : contact.push_endpoint);
                        const alreadyQueued = offerCommunications.some((job) => job.patient_contact_id === consent.patient_contact_id && job.channel === consent.channel && ["QUEUED", "PROCESSING", "SENT", "DELIVERED"].includes(job.status));
                        if (!contact || !configured || alreadyQueued) return [];
                        return [
                          <form key={`${contact.id}:${consent.channel}`} action={queueRecoveryMessage} className="rounded-lg bg-[var(--surface-sunken)] p-3">
                            <input type="hidden" name="recovery_case_id" value={caseId} />
                            <input type="hidden" name="recovery_offer_id" value={offer.id} />
                            <input type="hidden" name="message_type" value="RECOVERY_OFFER" />
                            <input type="hidden" name="contact_id" value={contact.id} />
                            <input type="hidden" name="channel" value={consent.channel} />
                            <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                            <p className="text-xs font-medium text-[var(--ink-primary)]">{contact.name} · {consent.channel}</p>
                            <Field label={`Delivery time (${contact.timezone})`}>
                              <input required name="scheduled_for" type="datetime-local" className={inputClass} defaultValue={formatDateTimeLocal(new Date(renderedAt + 60_000), contact.timezone)} />
                            </Field>
                            <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg bg-white p-3 text-xs text-[var(--ink-secondary)]">
                              <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                              <span>I confirm this recipient and consented channel. The job expires with this exact offer.</span>
                            </label>
                            <ActionSubmit className="mt-3" pendingLabel="Queuing message…">Queue {consent.channel}</ActionSubmit>
                          </form>,
                        ];
                      })}
                      {!consents.length && <p className="text-xs text-[var(--ink-secondary)]">No contact has an active consented channel. Update the patient contact record first.</p>}
                      <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Queued does not mean sent. No SMS/email provider is connected yet.</p>
                    </div>
                  </details>
                )}
                {pending && active && actionsReady && provenanceOptions.length > 0 && !contactsResult.error && !communicationsResult.error && (
                  <form action={respondRecoveryOffer} className="mt-4 space-y-3 border-t border-[var(--rule-hairline)] pt-4">
                    <input type="hidden" name="offer_id" value={offer.id} />
                    <input type="hidden" name="case_id" value={caseId} />
                    <input type="hidden" name="expected_version" value={recoveryCase.version} />
                    <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                    <Field label="Response provenance">
                      <select required name="provenance" className={inputClass} defaultValue="">
                        <option value="" disabled>Choose delivered message or manual response</option>
                        {provenanceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Response note" hint="For example: caregiver accepted by phone, or declined due to time.">
                      <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} />
                    </Field>
                    <label className="flex min-h-11 items-start gap-3 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">
                      <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                      <span>I confirm this exact contact gave the recorded response through the selected method.</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {canAccept && <ActionSubmit name="decision" value="ACCEPTED" pendingLabel="Booking…">Accepted · book visit</ActionSubmit>}
                      <ActionSubmit name="decision" value="DECLINED" tone="secondary" pendingLabel="Recording…">Declined</ActionSubmit>
                    </div>
                  </form>
                )}
                {pending && active && !provenanceOptions.length && !contactsResult.error && (
                  <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Add an active patient contact before recording a response. Digital responses also require a delivered job for this exact offer.</p>
                )}
                {offer.response_reason && <p className="mt-3 rounded-lg bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">{offer.response_reason}</p>}
              </Card>
            );
          })}
          {!offers.length && <div className="card p-5 text-sm text-[var(--ink-secondary)]">No offers have been recorded.</div>}
        </div>
      </section>

      {active && actionsReady && (
        <Card>
          <CardHeader title="Case controls" sub="Every decision is audited" />
          <form action={setRecoveryCaseState} className="mt-4 space-y-4">
            <input type="hidden" name="case_id" value={caseId} />
            <input type="hidden" name="expected_version" value={recoveryCase.version} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Action">
                <select name="status" className={inputClass} defaultValue={recoveryCase.status === "DEFERRED" ? "OPEN" : "DEFERRED"}>
                  <option value="DEFERRED">Defer for follow-up</option>
                  {recoveryCase.status === "DEFERRED" && <option value="OPEN">Return to open queue</option>}
                  {(!recoveryCase.requires_clinical_review || canApproveProtected) && (
                    <option value="CLOSED">Close without replacement</option>
                  )}
                </select>
              </Field>
              <Field label="Defer period" hint="Used only when deferring.">
                <select name="defer_hours" className={inputClass} defaultValue="24">
                  <option value="4">4 hours</option>
                  <option value="24">1 day</option>
                  <option value="72">3 days</option>
                  <option value="168">1 week</option>
                </select>
              </Field>
            </div>
            <Field label="Decision reason">
              <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Why is this the right next step?" />
            </Field>
            <ActionSubmit tone="secondary" pendingLabel="Updating case…">Update case</ActionSubmit>
          </form>
        </Card>
      )}

      {actionsReady && canWithdrawCallout && disruption.disruption_type === "PROVIDER_CALLOUT" && ["OPEN", "RESOLVED"].includes(disruption.status) && (
        <Card>
          <CardHeader title="Withdraw entire callout" sub="Future original visits are restored atomically" />
          <form action={withdrawProviderCallout} className="mt-4 space-y-3">
            <input type="hidden" name="disruption_id" value={disruption.id} />
            <input type="hidden" name="return_to" value={`/recovery/${caseId}`} />
            <input type="hidden" name="command_id" value={crypto.randomUUID()} />
            {!withdrawalWindowOpen && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                This callout has started. Already-started visits remain cancelled; only future original visits will return to the active schedule.
              </p>
            )}
            <Field label="Withdrawal reason">
              <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="For example: callout entered for the wrong date" />
            </Field>
            <label className="flex min-h-11 items-start gap-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">
              <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
              <span>I confirm the whole callout should be withdrawn. This is blocked if a replacement was accepted, and past visits will not be restored.</span>
            </label>
            <ActionSubmit tone="danger" pendingLabel="Restoring original visits…">Withdraw callout</ActionSubmit>
          </form>
        </Card>
      )}

      <p className="pb-2 text-center text-[0.6875rem] text-[var(--ink-muted)]">Schedule writes require a live connection and are never stored offline on this device.</p>
    </div>
  );
}

function RecoveryOptionCard({
  option,
  rank,
  caseId,
  version,
  providerName,
  locationName,
  timezone,
  renderedAt,
}: {
  option: RecoveryOption;
  rank: number;
  caseId: string;
  version: number;
  providerName: string;
  locationName: string;
  timezone: string;
  renderedAt: number;
}) {
  const minutesUntilStart = Math.floor((new Date(option.start_time).getTime() - renderedAt) / 60_000);
  const validityOptions = [5, 15, 30, 60, 240, 1_440].filter(
    (minutes) => minutes < minutesUntilStart - 1,
  );
  const defaultValidity = validityOptions.includes(60)
    ? 60
    : validityOptions[validityOptions.length - 1];
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">Option {rank}{rank === 1 ? " · Recommended" : ""}</p>
          <h3 className="mt-1 text-sm font-semibold text-[var(--ink-primary)]">{providerName}</h3>
          <p className="mt-1 text-xs text-[var(--ink-secondary)]">{formatRange(option.start_time, option.end_time, timezone)} · {locationName}</p>
        </div>
        {option.same_time && <span className="rounded-full bg-green-50 px-2.5 py-1 text-[0.6875rem] font-medium text-green-800">Same time</span>}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[var(--ink-secondary)]">{option.explanations[0]?.message}</p>
      <details className="mt-4 rounded-xl bg-[var(--surface-sunken)] p-3">
        <summary className="min-h-6 cursor-pointer text-xs font-medium text-[var(--ink-primary)]">Record offer</summary>
        <form action={createRecoveryOffer} className="mt-4 space-y-3">
          <input type="hidden" name="case_id" value={caseId} />
          <input type="hidden" name="expected_version" value={version} />
          <input type="hidden" name="option_id" value={option.id} />
          <Field label="Offer valid for">
            <select name="expiry_minutes" className={inputClass} defaultValue={String(defaultValidity)}>
              {validityOptions.map((minutes) => (
                <option key={minutes} value={minutes}>{formatValidity(minutes)}</option>
              ))}
            </select>
          </Field>
          <Field label="Offer note" hint="Document the outreach method, not contact details.">
            <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Called approved contact" />
          </Field>
          <ActionSubmit pendingLabel="Creating offer…">Create offer</ActionSubmit>
        </form>
      </details>
    </Card>
  );
}

function Detail({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? "flex items-start justify-between gap-3 text-sm" : ""}>
      <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
      <dd className={`${compact ? "text-right" : "mt-1"} text-sm font-medium text-[var(--ink-primary)]`}>{value}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "RESOLVED" || status === "ACCEPTED" || status === "CLOSED"
    ? "bg-green-50 text-green-800"
    : status === "OPEN" || status === "DECLINED" || status === "EXPIRED"
      ? "bg-red-50 text-red-700"
      : "bg-amber-50 text-amber-800";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${tone}`}>{humanize(status)}</span>;
}

function humanize(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function formatInstant(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}

function formatRange(start: string, end: string, timezone: string) {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(new Date(start));
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  return `${date}, ${time.format(new Date(start))}–${time.format(new Date(end))}`;
}

function formatValidity(minutes: number) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return "1 hour";
  if (minutes < 1_440) return `${minutes / 60} hours`;
  return "24 hours";
}
