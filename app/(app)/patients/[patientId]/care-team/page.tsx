import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { addCareTeamMember, endCareTeamMember } from "@/lib/careTeam/actions";
import { createClient } from "@/lib/supabase/server";

export default async function CareTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const canManage =
    can(session.role, "schedule.book") || can(session.role, "clinical.set_requirements");
  const [{ patientId }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const [{ data: patient }, { data: memberships }, { data: providers }] = await Promise.all([
    supabase.from("patients").select("id,first_name,last_name").eq("id", patientId).single(),
    supabase
      .from("patient_care_team")
      .select("id,provider_id,relationship,effective_start,effective_end,active")
      .eq("patient_id", patientId)
      .order("active", { ascending: false }),
    supabase
      .from("providers")
      .select("id,first_name,last_name,provider_type,status")
      .eq("status", "ACTIVE")
      .order("last_name"),
  ]);

  if (!patient) notFound();

  const providerMap = new Map((providers ?? []).map((provider) => [provider.id, provider]));

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/patients/${patient.id}`} className="text-xs underline underline-offset-4">
          ← Patient record
        </Link>
        <h1 className="mt-2 text-xl font-semibold">
          {patient.first_name} {patient.last_name} · care team
        </h1>
        <p className="text-sm text-[var(--ink-secondary)]">
          These assignments determine caseload visibility for clinicians and supervisors.
        </p>
      </div>

      {query.error && (
        <p role="alert" className="rounded-lg bg-[var(--surface-sunken)] p-3 text-sm text-[var(--status-critical)]">
          {query.error}
        </p>
      )}
      {query.notice && (
        <p role="status" className="rounded-lg bg-[var(--brand-tint)] p-3 text-sm">
          {query.notice}
        </p>
      )}

      <section className="card p-4">
        <h2 className="text-sm font-medium">Current and previous assignments</h2>
        <div className="mt-3 space-y-2">
          {(memberships ?? []).map((membership) => {
            const provider = providerMap.get(membership.provider_id);
            return (
              <article
                key={membership.id}
                className="flex flex-col gap-3 rounded-lg border border-[var(--rule-hairline)] p-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {provider
                      ? `${provider.first_name} ${provider.last_name}`
                      : "Unavailable clinician"}
                  </p>
                  <p className="text-xs text-[var(--ink-secondary)]">
                    {membership.relationship.replaceAll("_", " ")} · since {membership.effective_start}
                    {!membership.active && ` · ended ${membership.effective_end ?? "—"}`}
                  </p>
                </div>
                {canManage && membership.active && (
                  <form action={endCareTeamMember}>
                    <input type="hidden" name="patient_id" value={patientId} />
                    <input type="hidden" name="membership_id" value={membership.id} />
                    <ActionSubmit
                      tone="secondary"
                      className="w-full sm:w-auto"
                      pendingLabel="Ending assignment…"
                    >
                      End assignment
                    </ActionSubmit>
                  </form>
                )}
              </article>
            );
          })}
          {memberships?.length === 0 && (
            <p className="text-sm text-[var(--ink-secondary)]">No care-team assignments yet.</p>
          )}
        </div>
      </section>

      {canManage && (
        <section className="card p-4">
          <h2 className="text-sm font-medium">Add team member</h2>
          <form
            action={addCareTeamMember}
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_auto] lg:items-end"
          >
            <input type="hidden" name="patient_id" value={patientId} />
            <label className="text-xs text-[var(--ink-secondary)]">
              <span className="mb-1 block">Clinician</span>
              <select required name="provider_id" className={control}>
                <option value="">Choose clinician</option>
                {(providers ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.last_name}, {provider.first_name} · {provider.provider_type}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--ink-secondary)]">
              <span className="mb-1 block">Relationship</span>
              <select name="relationship" className={control}>
                <option value="PRIMARY_CLINICIAN">Primary clinician</option>
                <option value="SUPERVISOR">Supervisor</option>
                <option value="TREATING_PROVIDER">Treating provider</option>
                <option value="CARE_COORDINATOR">Care coordinator</option>
              </select>
            </label>
            <label className="text-xs text-[var(--ink-secondary)]">
              <span className="mb-1 block">Effective date</span>
              <input
                type="date"
                name="effective_start"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className={control}
              />
            </label>
            <ActionSubmit pendingLabel="Adding team member…">Add member</ActionSubmit>
          </form>
        </section>
      )}
    </div>
  );
}

const control =
  "min-h-11 w-full rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-2 text-sm";
