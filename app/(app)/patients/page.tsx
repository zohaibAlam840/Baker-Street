import Link from "next/link";

import { Card } from "@/components/charts";
import { ROLE_DEFINITIONS } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { slotsToHours } from "@/lib/domain/slots";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { summarisePatientWeek } from "@/lib/scheduling/summary";

export const dynamic = "force-dynamic";

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; q?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const { week, q } = await searchParams;
  const { ctx } = await loadHorizon({ startDate: week ?? defaultWeekStart() });

  const definition = ROLE_DEFINITIONS[session.role];
  const restricted =
    (definition.scope === "own" || definition.scope === "caseload") && session.providerId;

  const caseload = restricted
    ? new Set(
        (ctx.appointmentsByProvider.get(session.providerId!) ?? []).map((a) => a.patient_id),
      )
    : null;

  const query = (q ?? "").trim().toLowerCase();

  const rows = [...ctx.patients.values()]
    .filter((patient) => !caseload || caseload.has(patient.id))
    .filter(
      (patient) =>
        !query ||
        `${patient.first_name} ${patient.last_name} ${patient.external_id ?? ""}`
          .toLowerCase()
          .includes(query),
    )
    .map((patient) => {
      const summary = summarisePatientWeek(ctx, patient.id);
      const appointments = ctx.appointmentsByPatient.get(patient.id) ?? [];
      const hours = appointments.reduce(
        (total, a) => total + slotsToHours(a.range.endSlot - a.range.startSlot),
        0,
      );
      const headline = summary.rows.find((r) => r.target_hours != null);
      return { patient, summary, appointments: appointments.length, hours, headline };
    })
    .sort((a, b) => a.patient.last_name.localeCompare(b.patient.last_name));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
            {restricted ? "Your patients" : "Patients"}
          </h1>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            {rows.length} {rows.length === 1 ? "patient" : "patients"} · week of{" "}
            {ctx.grid.startDate}
          </p>
        </div>

        <form className="flex items-center gap-2">
          <input type="hidden" name="week" value={ctx.grid.startDate} />
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name or ID"
            className="h-10 w-56 rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-4 text-sm outline-none placeholder:text-[var(--ink-muted)] focus:ring-2 focus:ring-[var(--brand-ring)]"
          />
          <button
            type="submit"
            className="rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 py-2 text-sm text-[var(--ink-secondary)]"
          >
            Search
          </button>
        </form>
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--ink-secondary)]">
            No patients match. {query && "Try a different search."}
          </p>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ patient, summary, appointments, hours, headline }) => {
            const met = summary.required_services_met === summary.required_services_total;
            return (
              <li key={patient.id}>
                <Link
                  href={`/patients/${patient.id}`}
                  className="card block p-4 transition-shadow hover:shadow-[var(--shadow-float)]"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--brand-tint)] text-sm font-semibold text-[var(--brand)]"
                    >
                      {patient.first_name[0]}
                      {patient.last_name[0]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--ink-primary)]">
                        {patient.first_name} {patient.last_name}
                      </span>
                      <span className="block truncate text-xs text-[var(--ink-muted)]">
                        {patient.external_id}
                        {patient.status !== "ACTIVE" &&
                          ` · ${patient.status.toLowerCase()}`}
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium"
                      style={{
                        background: met ? "var(--brand-tint)" : "var(--surface-sunken)",
                        color: met ? "var(--brand)" : "var(--ink-secondary)",
                      }}
                    >
                      {summary.required_services_met}/{summary.required_services_total}
                    </span>
                  </div>

                  <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <dt className="text-[0.625rem] text-[var(--ink-muted)]">Hours</dt>
                      <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                        {Math.round(hours)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[0.625rem] text-[var(--ink-muted)]">Visits</dt>
                      <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                        {appointments}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[0.625rem] text-[var(--ink-muted)]">Target</dt>
                      <dd className="text-sm font-semibold tabular-nums text-[var(--ink-primary)]">
                        {headline?.target_hours ?? "—"}
                      </dd>
                    </div>
                  </dl>

                  {headline?.shortfall && (
                    <p className="mt-3 truncate text-[0.6875rem] text-[var(--ink-secondary)]">
                      {headline.shortfall}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
