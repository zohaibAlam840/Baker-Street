import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { WeekGrid } from "@/components/schedule/WeekGrid";
import { ServiceSummaryTable } from "@/components/schedule/tables";
import { IconArrowUpRight, IconCalendar, IconSpark } from "@/components/shell/icons";
import { manageGuardianPortalAccess, savePatientContact, setContactChannelConsent } from "@/lib/communications/actions";
import { ROLE_DEFINITIONS, can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "@/lib/domain/slots";
import { formatClockTime, parseClockTime } from "@/lib/domain/time";
import { defaultWeekStart, demoToday } from "@/lib/scheduling/defaults";
import { summarisePatientWeek } from "@/lib/scheduling/summary";
import { buildWeekView } from "@/lib/scheduling/weekView";
import { createClient } from "@/lib/supabase/server";
import { toggleIntakeTask } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface PatientContactRow {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  push_endpoint: string | null;
  is_primary: boolean;
  authorized_to_receive_information: boolean;
  is_legal_guardian: boolean;
  guardian_authority: string | null;
  preferred_language: string;
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  active: boolean;
  version: number;
}

interface ConsentRow {
  patient_contact_id: string;
  channel: "SMS" | "EMAIL" | "PUSH";
  status: "GRANTED" | "REVOKED";
  source: string;
  granted_at: string | null;
  revoked_at: string | null;
  version: number;
}

interface GuardianPortalAccessRow {
  patient_contact_id: string;
  status: "PENDING" | "ACTIVE" | "REVOKED";
  version: number;
  claimed_at: string | null;
  revoked_at: string | null;
}

/**
 * The patient record.
 *
 * Everything the engine reasons about for one patient, in the order a
 * clinician asks for it: where they stand this week, what they need, when
 * they are actually free, and what is booked. Availability, restrictions and
 * preferences are in the schema and drive every decision, so they belong on
 * screen rather than only in the database.
 */
export default async function PatientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string }>;
  searchParams: Promise<{ week?: string; error?: string; notice?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const { patientId } = await params;
  const query = await searchParams;
  const { week } = query;

  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });
  const patient = ctx.patients.get(patientId);
  if (!patient) notFound();
  const supabase = await createClient();
  const canViewContacts = can(session.role, "communications.view");
  const canManageContacts = can(session.role, "communications.manage");
  const [intakeResult, contactsResult] = await Promise.all([
    supabase.from("intake_tasks").select("id,label,completed").eq("patient_id",patientId).order("label"),
    canViewContacts
      ? supabase.from("patient_contacts").select("id,name,relationship,phone,email,push_endpoint,is_primary,authorized_to_receive_information,is_legal_guardian,guardian_authority,preferred_language,timezone,quiet_hours_start,quiet_hours_end,active,version").eq("patient_id",patientId).in("active", canManageContacts ? [true, false] : [true]).order("active",{ascending:false}).order("is_primary",{ascending:false})
      : Promise.resolve({ data: [] as PatientContactRow[], error: null }),
  ]);
  const intakeTasks = intakeResult.data;
  const contacts = (contactsResult.data ?? []) as PatientContactRow[];
  const consentsResult = canViewContacts && contacts.length
    ? await supabase.from("communication_consents").select("patient_contact_id,channel,status,source,granted_at,revoked_at,version").in("patient_contact_id", contacts.map((contact) => contact.id))
    : { data: [] as ConsentRow[], error: null };
  const consents = (consentsResult.data ?? []) as ConsentRow[];
  const portalAccessResult = canManageContacts && contacts.length
    ? await supabase.from("guardian_portal_access").select("patient_contact_id,status,version,claimed_at,revoked_at").in("patient_contact_id", contacts.map((contact) => contact.id))
    : { data: [] as GuardianPortalAccessRow[], error: null };
  const portalAccess = (portalAccessResult.data ?? []) as GuardianPortalAccessRow[];

  // A clinician scoped to their own caseload cannot open a patient they do
  // not see. Hiding the link is not enough — this is the check that matters.
  const scope = ROLE_DEFINITIONS[session.role].scope;
  if (synthetic && (scope === "own" || scope === "caseload") && session.providerId) {
    const mine = (ctx.appointmentsByProvider.get(session.providerId) ?? []).some(
      (a) => a.patient_id === patientId,
    );
    if (!mine) notFound();
  }

  const summary = summarisePatientWeek(ctx, patientId);
  const view = buildWeekView(ctx, { subject: { kind: "patient", id: patientId } });
  const appointments = ctx.appointmentsByPatient.get(patientId) ?? [];

  const headline = summary.rows.find((r) => r.target_hours != null) ?? summary.rows[0];
  const totalHours = appointments.reduce(
    (t, a) => t + slotsToHours(a.range.endSlot - a.range.startSlot),
    0,
  );

  const today = demoToday();
  const next = appointments
    .filter((a) => ctx.grid.instantOf(a.range.startSlot) >= today)
    .sort((a, b) => a.range.startSlot - b.range.startSlot)[0];

  const age = patient.date_of_birth
    ? 2026 - Number(patient.date_of_birth.slice(0, 4))
    : null;

  // Availability and what blocks it, by weekday.
  const availability = ctx.patientAvailability.get(patientId) ?? [];
  const restrictions = ctx.patientRestrictions.get(patientId) ?? [];
  const week7 = [1, 2, 3, 4, 5, 6, 0].map((day) => ({
    day,
    label: WEEKDAYS[day],
    open: availability
      .filter((a) => a.day_of_week === day && a.availability_type !== "HARD_UNAVAILABLE")
      .map((a) => `${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`),
    blocked: restrictions
      .filter((r) => r.day_of_week === day)
      .map(
        (r) =>
          `${r.restriction_type.toLowerCase().replace("_", " ")} ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
      ),
  }));

  const preferences = ctx.patientPreferences.get(patientId) ?? [];
  const authorizations = ctx.authorizations.get(patientId) ?? [];

  return (
    <div className="space-y-4">
      <Link
        href="/patients"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink-primary)]"
      >
        ← All patients
      </Link>
      {query.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}
      {(contactsResult.error || consentsResult.error || portalAccessResult.error) && canViewContacts && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">Contact and consent records could not be loaded. No changes were made.</p>
      )}
      {week && null}

      {/* ------------------------------- header ------------------------------- */}
      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className="grid size-14 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-lg font-semibold text-[var(--brand)]"
          >
            {patient.first_name[0]}
            {patient.last_name[0]}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
              {patient.first_name} {patient.last_name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-secondary)]">
              <span>{patient.external_id}</span>
              {age != null && <span>{age} years</span>}
              <span>
                {ctx.locations.get(patient.primary_location_id ?? "")?.name ?? "No base"}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background:
                      patient.status === "ACTIVE"
                        ? "var(--status-good)"
                        : "var(--status-warning)",
                  }}
                />
                {patient.status.charAt(0) + patient.status.slice(1).toLowerCase()}
              </span>
            </p>
          </div>

          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {!synthetic && (
              <Link
                href={`/api/integrations/ehr/patients/${patientId}/bundle`}
                className="inline-flex flex-1 items-center justify-center rounded-full border border-[var(--border-ring)] px-4 py-2.5 text-xs font-medium text-[var(--ink-primary)] sm:flex-none"
              >
                FHIR export
              </Link>
            )}
            {(can(session.role, "schedule.book") || can(session.role, "clinical.set_requirements")) && (
              <Link
                href={`/patients/${patientId}/care-team`}
                className="inline-flex flex-1 items-center justify-center rounded-full border border-[var(--border-ring)] px-4 py-2.5 text-xs font-medium text-[var(--ink-primary)] sm:flex-none"
              >
                Care team
              </Link>
            )}
            {can(session.role, "schedule.optimize") && (
              <Link
                href={`/optimize?patient=${patientId}&week=${ctx.grid.startDate}`}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-hover)] sm:flex-none"
              >
                <IconSpark className="size-4" />
                Fill service
              </Link>
            )}
            {can(session.role, "schedule.search_availability") && (
              <Link
                href={`/book?patient=${patientId}&week=${ctx.grid.startDate}`}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--border-ring)] px-4 py-2.5 text-xs font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-sunken)] sm:flex-none"
              >
                <IconCalendar className="size-4" />
                Find a time
              </Link>
            )}
          </div>
        </div>
      </Card>

      {/* -------------------------------- stats -------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">
            {headline?.service_name ?? "Scheduled"}
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {headline?.scheduled_hours ?? 0}
            <span className="ml-1 text-sm font-normal text-[var(--ink-muted)]">h</span>
          </div>
          {headline?.target_hours != null && (
            <>
              <div
                className="mt-3 h-1.5 w-full overflow-hidden rounded-full"
                style={{ background: "color-mix(in srgb, var(--brand) 16%, transparent)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (headline.scheduled_hours / headline.target_hours) * 100)}%`,
                    background: "var(--brand)",
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                Target {headline.target_hours}h
              </p>
            </>
          )}
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Required services</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {summary.required_services_met}/{summary.required_services_total}
          </div>
          <p
            className="mt-3 text-xs"
            style={{
              color:
                summary.required_services_met === summary.required_services_total
                  ? "var(--status-good)"
                  : "var(--status-warning)",
            }}
          >
            {summary.required_services_met === summary.required_services_total
              ? "All satisfied"
              : "One or more unmet"}
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">This week</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
            {appointments.length}
          </div>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            {Math.round(totalHours)}h across{" "}
            {new Set(appointments.map((a) => a.provider_id)).size} clinicians
          </p>
        </Card>

        <Card>
          <div className="text-xs text-[var(--ink-secondary)]">Next appointment</div>
          {next ? (
            <>
              <div className="mt-1 text-2xl font-semibold text-[var(--ink-primary)]">
                {SHORT_DAYS[ctx.grid.weekdayOf(Math.floor(next.range.startSlot / SLOTS_PER_DAY))]}{" "}
                <span className="tabular-nums">
                  {formatClockTime((next.range.startSlot % SLOTS_PER_DAY) * SLOT_MINUTES)}
                </span>
              </div>
              <p className="mt-3 truncate text-xs text-[var(--ink-muted)]">
                {ctx.services.get(next.service_id)?.service_name}
              </p>
            </>
          ) : (
            <>
              <div className="mt-1 text-2xl font-semibold text-[var(--ink-muted)]">—</div>
              <p className="mt-3 text-xs text-[var(--ink-muted)]">
                Nothing left this week
              </p>
            </>
          )}
        </Card>
      </div>

      {/* ------------------------- requirements & week ------------------------- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--ink-primary)]">
          Requirements and authorization
        </h2>
        <p className="max-w-3xl text-xs leading-relaxed text-[var(--ink-secondary)]">
          Scheduled, clinical minimum, target and authorized are four separate
          numbers. Authorization is what the payer will fund; it is never a
          statement of what the patient needs.
        </p>
        <ServiceSummaryTable rows={summary.rows} />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-[var(--ink-primary)]">This week</h2>
          <Link
            href={`/schedule/patient/${patientId}?week=${ctx.grid.startDate}`}
            className="inline-flex items-center gap-1 text-xs text-[var(--ink-secondary)] underline underline-offset-4"
          >
            Full schedule view
            <IconArrowUpRight className="size-3" />
          </Link>
        </div>
        <Card className="p-2">
          {/* Scrolls sideways on a phone rather than squashing the week. */}
          <WeekGrid view={view} />
        </Card>
        <p className="text-xs text-[var(--ink-muted)] lg:hidden">
          Swipe the calendar sideways to see the rest of the week.
        </p>
      </section>

      {/* --------------------- availability, prefs, payers --------------------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Intake readiness" sub={`${(intakeTasks??[]).filter(t=>t.completed).length}/${(intakeTasks??[]).length} complete`} />
          <div className="mt-3 space-y-2">{(intakeTasks??[]).map(task=><form key={task.id} action={toggleIntakeTask} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-sunken)] p-3"><input type="hidden" name="task_id" value={task.id}/><input type="hidden" name="patient_id" value={patientId}/><input type="hidden" name="complete" value={String(!task.completed)}/><span className="text-sm">{task.completed?"✓ ":""}{task.label}</span>{can(session.role,"schedule.book")&&<ActionSubmit tone="secondary" className="px-3 text-xs" pendingLabel={task.completed?"Reopening…":"Completing…"}>{task.completed?"Reopen":"Complete"}</ActionSubmit>}</form>)}</div>
        </Card>
        {canViewContacts && (
          <ContactsCard
            patientId={patientId}
            patientTimezone={patient.timezone}
            contacts={contacts}
            consents={consents}
            portalAccess={portalAccess}
            canManage={canManageContacts}
          />
        )}
        <Card>
          <CardHeader
            title="When they can be seen"
            sub="Declared availability, and what blocks it"
          />
          <ul className="mt-4 divide-y divide-[var(--rule-hairline)]">
            {week7.map((day) => (
              <li key={day.day} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                <span className="w-20 shrink-0 text-xs font-medium text-[var(--ink-primary)]">
                  {day.label}
                </span>
                <span className="min-w-0 flex-1">
                  {day.open.length === 0 ? (
                    <span className="text-xs text-[var(--ink-muted)]">Not available</span>
                  ) : (
                    <span className="text-xs tabular-nums text-[var(--ink-secondary)]">
                      {day.open.join(", ")}
                    </span>
                  )}
                  {day.blocked.length > 0 && (
                    <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                      Blocked: {day.blocked.join(", ")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader title="Preferences" sub="Soft unless marked otherwise" />
            {preferences.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">
                None recorded.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {preferences.map((preference) => {
                  const parts: string[] = [];
                  if (preference.preferred_provider_id) {
                    const provider = ctx.providers.get(preference.preferred_provider_id);
                    if (provider) {
                      parts.push(`${provider.first_name} ${provider.last_name}`);
                    }
                  }
                  if (preference.preferred_location_id) {
                    parts.push(
                      ctx.locations.get(preference.preferred_location_id)?.name ?? "",
                    );
                  }
                  if (preference.preferred_day != null) {
                    parts.push(WEEKDAYS[preference.preferred_day]);
                  }
                  if (preference.preferred_start_time && preference.preferred_end_time) {
                    parts.push(
                      `${formatClockTime(parseClockTime(preference.preferred_start_time))}–${formatClockTime(
                        parseClockTime(preference.preferred_end_time),
                      )}`,
                    );
                  }
                  return (
                    <li
                      key={preference.id}
                      className="flex items-start justify-between gap-3 rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5"
                    >
                      <span className="min-w-0 text-xs text-[var(--ink-primary)]">
                        {preference.preferred_service_id
                          ? `${ctx.services.get(preference.preferred_service_id)?.service_name}: `
                          : ""}
                        {parts.filter(Boolean).join(" · ") || "No detail"}
                      </span>
                      <span className="shrink-0 text-[0.625rem] text-[var(--ink-muted)]">
                        {preference.is_hard_constraint ? "Required" : "Preferred"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Authorizations" sub="What the payer has approved" />
            {authorizations.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ink-secondary)]">
                None on file.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {authorizations.map((authorization) => {
                  const used = slotsToHours(
                    ctx.slotsUsedAgainstAuthorization(authorization.id),
                  );
                  return (
                    <li
                      key={authorization.id}
                      className="rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <Link href={`/authorizations/${authorization.id}?week=${ctx.grid.startDate}`} className="min-w-0 truncate text-xs font-medium text-[var(--ink-primary)] underline underline-offset-4">
                          {ctx.services.get(authorization.service_id)?.service_name}
                        </Link>
                        <span className="shrink-0 text-xs tabular-nums text-[var(--ink-secondary)]">
                          {used}h / {authorization.authorized_hours ?? "—"}h
                        </span>
                      </div>
                      <div className="mt-1 text-[0.625rem] text-[var(--ink-muted)]">
                        {authorization.payer ?? "No payer"} ·{" "}
                        {authorization.authorization_number ?? "no reference"} ·{" "}
                        {authorization.start_date} → {authorization.end_date}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ContactsCard({
  patientId,
  patientTimezone,
  contacts,
  consents,
  portalAccess,
  canManage,
}: {
  patientId: string;
  patientTimezone: string;
  contacts: PatientContactRow[];
  consents: ConsentRow[];
  portalAccess: GuardianPortalAccessRow[];
  canManage: boolean;
}) {
  return (
    <Card>
      <CardHeader title="Contacts and consent" sub="Scheduling messages only go to a named recipient with channel consent" />
      <div className="mt-3 space-y-3">
        {contacts.map((contact) => {
          const contactConsents = consents.filter((consent) => consent.patient_contact_id === contact.id);
          const guardianAccess = portalAccess.find((access) => access.patient_contact_id === contact.id);
          return (
            <article key={contact.id} className="rounded-xl bg-[var(--surface-sunken)] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-[var(--ink-primary)]">{contact.name}{contact.is_primary ? " · primary" : ""}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">
                    {contact.relationship}{contact.is_legal_guardian ? " · legal guardian" : ""}
                    {contact.is_legal_guardian && contact.guardian_authority && contact.guardian_authority !== "NONE" ? ` · ${humanizeContactValue(contact.guardian_authority)}` : ""}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[0.6875rem] ${!contact.active ? "bg-[var(--surface-1)] text-[var(--ink-secondary)]" : contact.authorized_to_receive_information ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}>
                  {!contact.active ? "Inactive recipient" : contact.authorized_to_receive_information ? "Information authorized" : "Not authorized"}
                </span>
              </div>

              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <p><span className="text-[var(--ink-muted)]">SMS</span><span className="ml-2 text-[var(--ink-primary)]">{maskPhone(contact.phone)}</span></p>
                <p><span className="text-[var(--ink-muted)]">Email</span><span className="ml-2 text-[var(--ink-primary)]">{maskEmail(contact.email)}</span></p>
                <p><span className="text-[var(--ink-muted)]">Language</span><span className="ml-2 text-[var(--ink-primary)]">{contact.preferred_language}</span></p>
                <p><span className="text-[var(--ink-muted)]">Timezone</span><span className="ml-2 text-[var(--ink-primary)]">{contact.timezone}</span></p>
                <p className="sm:col-span-2"><span className="text-[var(--ink-muted)]">Quiet hours</span><span className="ml-2 text-[var(--ink-primary)]">{contact.quiet_hours_start && contact.quiet_hours_end ? `${contact.quiet_hours_start.slice(0, 5)}–${contact.quiet_hours_end.slice(0, 5)}` : "Not set"}</span></p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {(["SMS", "EMAIL", "PUSH"] as const).map((channel) => {
                  const consent = contactConsents.find((item) => item.channel === channel);
                  const configured = channel === "SMS" ? !!contact.phone : channel === "EMAIL" ? !!contact.email : !!contact.push_endpoint;
                  return (
                    <span key={channel} className={`rounded-full px-2.5 py-1 text-[0.6875rem] ${consent?.status === "GRANTED" && configured ? "bg-green-50 text-green-800" : "bg-[var(--surface-1)] text-[var(--ink-secondary)]"}`}>
                      {channel}: {!configured ? "unavailable" : consent?.status === "GRANTED" ? "consented" : consent?.status === "REVOKED" ? "revoked" : "not recorded"}
                    </span>
                  );
                })}
              </div>

              {canManage && (
                <div className="mt-3 space-y-2">
                  {contact.is_legal_guardian && (
                    <details className="rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3">
                      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-xs font-medium text-[var(--brand)]">
                        <span>Guardian portal access</span>
                        <span className="text-[0.6875rem] font-normal text-[var(--ink-muted)]">{guardianAccess?.status.toLowerCase() ?? "not approved"}</span>
                      </summary>
                      <form action={manageGuardianPortalAccess} className="space-y-3 pb-3">
                        <input type="hidden" name="patient_id" value={patientId} />
                        <input type="hidden" name="contact_id" value={contact.id} />
                        <input type="hidden" name="expected_version" value={guardianAccess?.version ?? 0} />
                        <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">Read-only access shows scheduled and confirmed appointments for 90 days. The signed-in email must exactly match this contact record.</p>
                        <Field label="Decision reason"><input required minLength={3} maxLength={500} name="reason" className={inputClass} placeholder={guardianAccess?.status === "ACTIVE" || guardianAccess?.status === "PENDING" ? "Why access is being revoked" : "Authority and identity verification reviewed"} /></Field>
                        <label className="flex min-h-11 items-start gap-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><input required name="confirmed" type="checkbox" className="mt-0.5 size-4"/><span>I verified the legal guardian, approved email, and information-release authority for this decision.</span></label>
                        {guardianAccess?.status === "ACTIVE" || guardianAccess?.status === "PENDING"
                          ? <ActionSubmit name="decision" value="REVOKE" tone="danger" pendingLabel="Revoking…">Revoke portal access</ActionSubmit>
                          : <ActionSubmit name="decision" value="ENABLE" pendingLabel="Approving…">Approve portal access</ActionSubmit>}
                      </form>
                    </details>
                  )}
                  <details className="rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3">
                    <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-[var(--brand)]">Edit contact details</summary>
                    <ContactForm patientId={patientId} patientTimezone={patientTimezone} contact={contact} />
                  </details>
                  <details className="rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3">
                    <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-[var(--brand)]">Update channel consent</summary>
                    <div className="space-y-3 pb-3">
                      {(["SMS", "EMAIL"] as const).map((channel) => {
                        const configured = channel === "SMS" ? !!contact.phone : !!contact.email;
                        const consent = contactConsents.find((item) => item.channel === channel);
                        const priorSource = consent?.source?.toUpperCase() ?? "";
                        const reconsentRequired = ["STOP", "UNSUBSCRIBE", "PROVIDER_OPT_OUT", "PROVIDER_COMPLAINT", "HARD_BOUNCE"].includes(priorSource);
                        const ordinarySources = ["VERBAL", "WRITTEN", "IN_PERSON"];
                        const defaultSource = reconsentRequired
                          ? "VERIFIED_RECONSENT"
                          : ordinarySources.includes(priorSource) ? priorSource : "VERBAL";
                        if (!configured) return <p key={channel} className="text-xs text-[var(--ink-muted)]">Add a {channel === "SMS" ? "phone number" : "email address"} before recording {channel} consent.</p>;
                        if (!contact.active && consent?.status !== "GRANTED") {
                          return <p key={channel} className="text-xs text-[var(--ink-muted)]">Reactivate this recipient before granting {channel} consent.</p>;
                        }
                        if (!contact.authorized_to_receive_information && consent?.status !== "GRANTED") {
                          return <p key={channel} className="text-xs text-[var(--ink-muted)]">Authorize this recipient for patient information before granting {channel} consent.</p>;
                        }
                        return (
                          <form key={channel} action={setContactChannelConsent} className="rounded-lg bg-[var(--surface-sunken)] p-3">
                            <input type="hidden" name="patient_id" value={patientId} />
                            <input type="hidden" name="contact_id" value={contact.id} />
                            <input type="hidden" name="channel" value={channel} />
                            <input type="hidden" name="expected_version" value={consent?.version ?? ""} />
                            <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-medium text-[var(--ink-primary)]">{channel}</p>
                              <span className="text-[0.6875rem] text-[var(--ink-muted)]">{consent?.status ? consent.status.toLowerCase() : "not recorded"}</span>
                            </div>
                            {reconsentRequired && (
                              <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-800">
                                This channel was suppressed after an opt-out, complaint, unsubscribe, or hard bounce. Re-enable it only after fresh verified or signed consent is documented.
                              </p>
                            )}
                            <Field label="How consent was recorded">
                              <select required name="source" defaultValue={defaultSource} className={inputClass}>
                                <option value="VERBAL">Verbal confirmation</option>
                                <option value="WRITTEN">Written form</option>
                                <option value="IN_PERSON">In person</option>
                                <option value="VERIFIED_RECONSENT">Verified re-consent after opt-out</option>
                                <option value="SIGNED_RECONSENT">Signed re-consent after opt-out</option>
                              </select>
                            </Field>
                            <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                              <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                              <span>I confirm this matches the recipient&apos;s current choice for {channel}.</span>
                            </label>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {consent?.status !== "GRANTED" && <ActionSubmit name="status" value="GRANTED" pendingLabel="Saving…">Grant consent</ActionSubmit>}
                              {consent?.status === "GRANTED" && <ActionSubmit name="status" value="REVOKED" tone="danger" pendingLabel="Revoking…">Revoke consent</ActionSubmit>}
                            </div>
                          </form>
                        );
                      })}
                    </div>
                  </details>
                </div>
              )}
            </article>
          );
        })}
        {!contacts.length && <p className="py-4 text-sm text-[var(--ink-secondary)]">No contacts recorded.</p>}
      </div>

      {canManage && (
        <details className="mt-4 rounded-xl border border-[var(--border-ring)] px-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-[var(--brand)]">Add contact</summary>
          <ContactForm patientId={patientId} patientTimezone={patientTimezone} />
        </details>
      )}
    </Card>
  );
}

function ContactForm({ patientId, patientTimezone, contact }: { patientId: string; patientTimezone: string; contact?: PatientContactRow }) {
  return (
    <form action={savePatientContact} className="grid gap-3 pb-3 sm:grid-cols-2">
      <input type="hidden" name="patient_id" value={patientId} />
      <input type="hidden" name="contact_id" value={contact?.id ?? ""} />
      <input type="hidden" name="expected_version" value={contact?.version ?? ""} />
      <input type="hidden" name="command_id" value={crypto.randomUUID()} />
      <Field label="Name"><input required minLength={2} maxLength={120} name="name" defaultValue={contact?.name} className={inputClass} autoComplete="name" /></Field>
      <Field label="Relationship"><input required minLength={2} maxLength={80} name="relationship" defaultValue={contact?.relationship} className={inputClass} placeholder="Parent, guardian, caregiver" /></Field>
      <Field label="Mobile number"><input name="phone" type="tel" defaultValue={contact?.phone ?? ""} className={inputClass} autoComplete="tel" /></Field>
      <Field label="Email"><input name="email" type="email" defaultValue={contact?.email ?? ""} className={inputClass} autoComplete="email" /></Field>
      <Field label="Preferred language" hint="BCP 47 code, such as en or es-US"><input required name="preferred_language" defaultValue={contact?.preferred_language ?? "en"} className={inputClass} /></Field>
      <Field label="Timezone"><input required name="timezone" defaultValue={contact?.timezone ?? patientTimezone} className={inputClass} /></Field>
      <Field label="Quiet hours start"><input name="quiet_hours_start" type="time" defaultValue={contact?.quiet_hours_start?.slice(0, 5) ?? ""} className={inputClass} /></Field>
      <Field label="Quiet hours end"><input name="quiet_hours_end" type="time" defaultValue={contact?.quiet_hours_end?.slice(0, 5) ?? ""} className={inputClass} /></Field>
      <Field label="Guardian authority" hint="Required when legal guardian is selected">
        <select name="guardian_authority" defaultValue={contact?.guardian_authority ?? "NONE"} className={inputClass}>
          <option value="NONE">Not a legal guardian</option>
          <option value="CUSTODIAL">Custodial authority</option>
          <option value="MEDICAL">Medical decision authority</option>
          <option value="LIMITED">Limited authority</option>
          <option value="OTHER">Other documented authority</option>
        </select>
      </Field>
      <div className="space-y-1 sm:pt-6">
        <label className="flex min-h-11 items-center gap-2 text-sm"><input name="is_primary" type="checkbox" defaultChecked={contact?.is_primary} className="size-4" /> Primary contact</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input name="is_legal_guardian" type="checkbox" defaultChecked={contact?.is_legal_guardian} className="size-4" /> Legal guardian</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input name="authorized" type="checkbox" defaultChecked={contact?.authorized_to_receive_information} className="size-4" /> Authorized for patient information</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input name="active" type="checkbox" defaultChecked={contact?.active ?? true} className="size-4" /> Active recipient</label>
      </div>
      {contact && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 sm:col-span-2">Changing a phone number or email revokes consent for that destination and cancels its outstanding messages. Record fresh consent afterward.</p>}
      <label className="flex min-h-11 items-start gap-3 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)] sm:col-span-2">
        <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
        <span>I verified this recipient and these details are appropriate for scheduling messages.</span>
      </label>
      <ActionSubmit className="sm:col-span-2" pendingLabel="Saving contact…">{contact ? "Save contact" : "Add contact"}</ActionSubmit>
    </form>
  );
}

function maskPhone(value: string | null) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Not recorded";
}

function maskEmail(value: string | null) {
  if (!value?.includes("@")) return "Not recorded";
  return `•••@${value.split("@")[1]}`;
}

function humanizeContactValue(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
