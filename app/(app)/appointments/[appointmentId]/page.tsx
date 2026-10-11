import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardHeader } from "@/components/charts";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { can } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { formatDateTimeLocal } from "@/lib/domain/time";
import { cancelAppointment, restoreAppointment, updateAppointment } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";

export default async function AppointmentDetailPage({ params, searchParams }: {
  params: Promise<{ appointmentId: string }>;
  searchParams: Promise<{ week?: string; edit?: string; error?: string; notice?: string }>;
}) {
  const session = await requirePermission("view.patient_schedule");
  const [{ appointmentId }, query] = await Promise.all([params, searchParams]);
  const { ctx, synthetic } = await loadHorizon({ startDate: query.week ?? defaultWeekStart() });
  const appointment = ctx.rows.appointments.find((item) => item.id === appointmentId);
  if (!appointment) notFound();

  const patient = ctx.patients.get(appointment.patient_id);
  const displayTimeZone = patient?.timezone ?? ctx.grid.timeZone;
  const provider = appointment.provider_id ? ctx.providers.get(appointment.provider_id) : null;
  const service = ctx.services.get(appointment.service_id);
  const resources = ctx.rows.appointmentResources
    .filter((item) => item.appointment_id === appointment.id)
    .map((item) => ctx.resources.get(item.resource_id)?.name)
    .filter(Boolean);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(appointment.start_time));
  const time = new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, hour: "numeric", minute: "2-digit" });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/schedule?week=${ctx.grid.startDate}`} className="text-xs text-[var(--ink-secondary)] underline underline-offset-4">← Practice schedule</Link>
          <h1 className="mt-2 text-xl font-semibold text-[var(--ink-primary)]">{service?.service_name ?? "Appointment"}</h1>
          <p className="mt-1 text-sm text-[var(--ink-secondary)]">{date} · {time.format(new Date(appointment.start_time))}–{time.format(new Date(appointment.end_time))}</p>
        </div>
        <span className="rounded-full bg-[var(--surface-sunken)] px-3 py-1 text-xs font-medium text-[var(--ink-secondary)]">{appointment.status}</span>
      </div>

      {query.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
      {query.notice && <p role="status" className="rounded-lg bg-[var(--brand-tint)] p-3 text-sm">{query.notice}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader title="Appointment details" sub={synthetic ? "Synthetic record" : "Live record"} />
          <form action={updateAppointment} className="space-y-5">
            <input type="hidden" name="appointment_id" value={appointment.id}/>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Patient"><input disabled className={inputClass} defaultValue={patient ? `${patient.first_name} ${patient.last_name}` : "Unknown"} /></Field>
              <Field label="Service"><input disabled className={inputClass} defaultValue={service?.service_name ?? "Unknown"} /></Field>
              <Field label="Clinician"><select name="provider_id" className={inputClass} defaultValue={appointment.provider_id ?? ""}><option value="">Unassigned</option>{[...ctx.providers.values()].map((item) => <option key={item.id} value={item.id}>{item.first_name} {item.last_name}</option>)}</select></Field>
              <Field label="Location"><select name="location_id" className={inputClass} defaultValue={appointment.location_id ?? ""}><option value="">No location</option>{[...ctx.locations.values()].map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
              <Field label="Start"><input name="start_time" type="datetime-local" className={inputClass} defaultValue={formatDateTimeLocal(new Date(appointment.start_time), displayTimeZone)} /></Field>
              <Field label="End"><input name="end_time" type="datetime-local" className={inputClass} defaultValue={formatDateTimeLocal(new Date(appointment.end_time), displayTimeZone)} /></Field>
              <Field label="Status"><select name="status" className={inputClass} defaultValue={appointment.status}>{["SCHEDULED","CONFIRMED","COMPLETED","CANCELLED","NO_SHOW"].map((value) => <option key={value}>{value}</option>)}</select></Field>
              <Field label="Scheduling protection"><select name="scheduling_flexibility" className={inputClass} defaultValue={appointment.scheduling_flexibility}>{["FLEXIBLE","PROTECTED","LOCKED"].map((value) => <option key={value}>{value}</option>)}</select></Field>
            </div>
            <Field label="Reason for change"><textarea name="reason" className={`${inputClass} min-h-24`} placeholder="Document why this change is needed" /></Field>
            {can(session.role,"schedule.book")&&<button className="min-h-11 rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white">Save appointment</button>}
          </form>
        </Card>

        <div className="space-y-4">
          <Card><CardHeader title="Booking context" /><dl className="mt-4 space-y-3 text-sm"><Row label="Authorization" value={appointment.authorization_id ? "Linked" : "None"} /><Row label="Delivery" value={appointment.telehealth ? "Telehealth" : "In person"} /><Row label="Resources" value={resources.join(", ") || "None"} /><Row label="Timezone" value={displayTimeZone} /></dl></Card>
          <Card><CardHeader title="Related records" /><div className="mt-4 grid gap-2 text-sm">{patient && <Link className="underline underline-offset-4" href={`/patients/${patient.id}?week=${ctx.grid.startDate}`}>Patient record</Link>}{provider && <Link className="underline underline-offset-4" href={`/providers/${provider.id}?week=${ctx.grid.startDate}`}>Clinician record</Link>}{appointment.authorization_id && <Link className="underline underline-offset-4" href={`/authorizations/${appointment.authorization_id}?week=${ctx.grid.startDate}`}>Authorization</Link>}</div></Card>
          {can(session.role,"schedule.book")&&<Card><CardHeader title={appointment.status==="CANCELLED"?"Restore appointment":"Cancel appointment"}/>{appointment.status==="CANCELLED"?<form action={restoreAppointment} className="mt-4"><input type="hidden" name="appointment_id" value={appointment.id}/><button className="min-h-11 w-full rounded-full border border-[var(--border-ring)] text-sm">Restore appointment</button></form>:<form action={cancelAppointment} className="mt-4 space-y-3"><input type="hidden" name="appointment_id" value={appointment.id}/><textarea required name="reason" className={`${inputClass} min-h-20`} placeholder="Cancellation reason"/><button className="min-h-11 w-full rounded-full bg-red-700 text-sm font-medium text-white">Cancel appointment</button></form>}</Card>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3"><dt className="text-[var(--ink-secondary)]">{label}</dt><dd className="text-right font-medium text-[var(--ink-primary)]">{value}</dd></div>; }
