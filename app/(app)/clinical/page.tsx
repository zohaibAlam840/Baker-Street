import Link from "next/link";

import { ServiceSummaryTable } from "@/components/schedule/tables";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { summarisePatientWeek } from "@/lib/scheduling/summary";

export const dynamic = "force-dynamic";

/**
 * The clinical supervisor's view: what each patient needs, against what they
 * are getting. This is the only role that may change these numbers, and they
 * are set independently of what any payer approved.
 */
export default async function ClinicalPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const session = await requirePermission("clinical.set_requirements");
  const { week } = await searchParams;
  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  // Caseload scope: the patients this supervisor actually sees.
  const caseload = session.providerId
    ? new Set(
        (ctx.appointmentsByProvider.get(session.providerId) ?? []).map((a) => a.patient_id),
      )
    : null;

  const patients = [...ctx.patients.values()]
    .filter((p) => !caseload || caseload.size === 0 || caseload.has(p.id))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">
          Clinical requirements
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--ink-secondary)]">
          What each patient clinically needs each week — a floor, a target and a
          ceiling — set independently of what the payer has authorized. Where
          those two numbers agree it should be because a clinician decided so,
          not because one was copied from the other.
        </p>
      </div>

      {patients.map((patient) => {
        const summary = summarisePatientWeek(ctx, patient.id);
        return (
          <section key={patient.id} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium text-[var(--ink-primary)]">
                {patient.first_name} {patient.last_name}
              </h2>
              <span className="text-xs text-[var(--ink-secondary)]">
                {summary.required_services_met}/{summary.required_services_total}{" "}
                required services met ·{" "}
                <Link
                  href={`/schedule/patient/${patient.id}?week=${ctx.grid.startDate}`}
                  className="underline underline-offset-4"
                >
                  see week
                </Link>
              </span>
            </div>
            <ServiceSummaryTable rows={summary.rows} />
          </section>
        );
      })}

      <p className="text-xs text-[var(--ink-secondary)]">
        Read-only for now{synthetic && " · synthetic data"}. Editing these
        numbers is a clinical decision and needs a signed-in identity and an
        audit trail behind it.
      </p>
    </div>
  );
}
