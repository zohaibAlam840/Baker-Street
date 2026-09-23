import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const dynamic = "force-dynamic";

/**
 * The authorization specialist's view.
 *
 * Deliberately shows authorized hours WITHOUT the clinical minimum or target
 * beside them. This role does not set clinical need, and putting the clinical
 * numbers on the same screen invites exactly the drift the data model exists
 * to prevent — "it's authorized for 30, so make the target 30".
 */
export default async function AuthorizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  await requirePermission("authorization.manage");
  const { week } = await searchParams;
  const { ctx, synthetic } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const rows = [];
  for (const [patientId, authorizations] of ctx.authorizations) {
    const patient = ctx.patients.get(patientId);
    for (const authorization of authorizations) {
      const used = slotsToHours(ctx.slotsUsedAgainstAuthorization(authorization.id));
      rows.push({
        authorization,
        patientName: patient
          ? `${patient.first_name} ${patient.last_name}`
          : "Unknown patient",
        serviceName:
          ctx.services.get(authorization.service_id)?.service_name ?? "Unknown service",
        used,
        remaining:
          authorization.authorized_hours == null
            ? null
            : Math.max(0, authorization.authorized_hours - used),
      });
    }
  }
  rows.sort((a, b) => a.authorization.end_date.localeCompare(b.authorization.end_date));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--ink-primary)]">Authorizations</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--ink-secondary)]">
          What each payer has approved, and how much of it is on the calendar
          this week. Authorized hours are a ceiling on what can be billed — they
          are not a statement of what the patient needs.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--rule-hairline)]">
              <th className={thClass}>Patient</th>
              <th className={thClass}>Service</th>
              <th className={thClass}>Payer</th>
              <th className={thClass}>Reference</th>
              <th className={`${thClass} text-right`}>Authorized</th>
              <th className={`${thClass} text-right`}>Used</th>
              <th className={`${thClass} text-right`}>Remaining</th>
              <th className={thClass}>Period</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ authorization, patientName, serviceName, used, remaining }) => (
              <tr
                key={authorization.id}
                className="border-b border-[var(--rule-hairline)] last:border-0"
              >
                <td className="px-3 py-2">{patientName}</td>
                <td className="px-3 py-2">{serviceName}</td>
                <td className="px-3 py-2 text-[var(--ink-secondary)]">
                  {authorization.payer ?? "—"}
                </td>
                <td className="px-3 py-2 text-[var(--ink-secondary)]">
                  {authorization.authorization_number ?? "—"}
                </td>
                <td className={numClass}>{authorization.authorized_hours ?? "—"}h</td>
                <td className={numClass}>{used}h</td>
                <td className={numClass}>{remaining ?? "—"}h</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[var(--ink-secondary)]">
                  {authorization.start_date} → {authorization.end_date}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--ink-secondary)]">
                    <span
                      aria-hidden
                      className="inline-block size-1.5 rounded-full"
                      style={{
                        background:
                          authorization.status === "ACTIVE"
                            ? "var(--status-good)"
                            : "var(--status-warning)",
                      }}
                    />
                    {authorization.status.charAt(0) +
                      authorization.status.slice(1).toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--ink-secondary)]">
        Read-only for now{synthetic && " · synthetic data"}. Adding and renewing
        authorizations needs write access and an audit trail, which arrive with
        real authentication.
      </p>
    </div>
  );
}

const thClass =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]";
const numClass = "px-3 py-2 text-right tabular-nums";
