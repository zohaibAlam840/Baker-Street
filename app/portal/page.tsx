import { redirect } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { guardianPortalSignOut } from "@/lib/portal/actions";
import { guardianPortalEnabled } from "@/lib/portal/config";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface PortalAppointment {
  id: string; start_time: string; end_time: string; status: string; telehealth: boolean;
  service_name: string; provider_name: string | null; location_name: string | null;
}
interface PortalPatient {
  id: string; first_name: string; last_name: string; timezone: string; appointments: PortalAppointment[];
}
interface PortalSnapshot { patients: PortalPatient[] }

export default async function GuardianPortalPage() {
  let enabled = false;
  try { enabled = guardianPortalEnabled(); } catch { /* handled below */ }
  if (!enabled) redirect("/portal/login?error=Guardian%20access%20is%20not%20enabled.");
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/portal/login");
  await supabase.rpc("claim_guardian_portal_access");
  const { data, error } = await supabase.rpc("guardian_portal_snapshot");
  const snapshot = (data ?? { patients: [] }) as PortalSnapshot;

  return (
    <main className="min-h-dvh bg-[var(--surface-1)] px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">Private family access</p><h1 className="mt-1 text-2xl font-semibold">Upcoming appointments</h1></div>
          <form action={guardianPortalSignOut}><ActionSubmit tone="secondary" pendingLabel="Signing out…">Sign out</ActionSubmit></form>
        </header>
        <p className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-secondary)]">This portal is read-only. Contact the scheduling team to change or cancel an appointment. Do not use it for emergencies.</p>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">Guardian access could not be loaded. Sign out and try your secure link again.</p>}
        {!error && snapshot.patients.length === 0 && <Card><CardHeader title="Access awaiting approval"/><p className="mt-3 text-sm text-[var(--ink-secondary)]">This signed-in email does not yet match an approved guardian record. Ask the scheduling team to verify the email, legal authority, and information-release permission.</p></Card>}
        {snapshot.patients.map((patient) => (
          <Card key={patient.id}>
            <CardHeader title={`${patient.first_name} ${patient.last_name}`} sub={`Times shown in ${patient.timezone}`} />
            {patient.appointments.length === 0 ? <p className="mt-4 text-sm text-[var(--ink-secondary)]">No scheduled or confirmed appointments in the next 90 days.</p> : (
              <ul className="mt-4 divide-y divide-[var(--rule-hairline)]">
                {patient.appointments.map((appointment) => {
                  const start = new Date(appointment.start_time);
                  const end = new Date(appointment.end_time);
                  return <li key={appointment.id} className="grid gap-1 py-4 sm:grid-cols-[12rem_1fr_auto] sm:items-center sm:gap-4"><time className="text-sm font-medium">{start.toLocaleString("en-US", { timeZone: patient.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}<span className="block text-xs font-normal text-[var(--ink-muted)]">to {end.toLocaleTimeString("en-US", { timeZone: patient.timezone, hour: "numeric", minute: "2-digit" })}</span></time><span><span className="block text-sm font-medium">{appointment.service_name}</span><span className="block text-xs text-[var(--ink-secondary)]">{appointment.provider_name ?? "Provider pending"} · {appointment.telehealth ? "Telehealth" : appointment.location_name ?? "Location pending"}</span></span><span className="w-fit rounded-full bg-[var(--surface-sunken)] px-2.5 py-1 text-xs">{appointment.status.toLowerCase()}</span></li>;
                })}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </main>
  );
}
