import Link from "next/link";
import { Card, CardHeader } from "@/components/charts";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { requirePermission } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";
import { createAppointment } from "@/lib/workflows/actions";

export const dynamic = "force-dynamic";
export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<Record<string,string|undefined>> }) {
  await requirePermission("schedule.book"); const query=await searchParams;
  const {ctx}=await loadHorizon({startDate:query.week??defaultWeekStart()});
  return <div className="space-y-5"><div><Link href={`/book?week=${ctx.grid.startDate}`} className="text-xs underline underline-offset-4 text-[var(--ink-secondary)]">← Find a time</Link><h1 className="mt-2 text-xl font-semibold">Book appointment</h1><p className="text-sm text-[var(--ink-secondary)]">Every occurrence is revalidated for conflicts, service delivery, and authorization at commit.</p></div>
  {query.error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{query.error}</p>}
  <Card><CardHeader title="Appointment" sub="Required fields are marked"/><form action={createAppointment} className="mt-5 space-y-5"><div className="grid gap-4 sm:grid-cols-2">
    <Field label="Patient"><select required name="patient_id" className={inputClass} defaultValue={query.patient??""}><option value="">Select patient</option>{[...ctx.patients.values()].map(p=><option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}</select></Field>
    <Field label="Service"><select required name="service_id" className={inputClass} defaultValue={query.service??""}><option value="">Select service</option>{[...ctx.services.values()].map(s=><option key={s.id} value={s.id}>{s.service_name}</option>)}</select></Field>
    <Field label="Clinician"><select required name="provider_id" className={inputClass} defaultValue={query.provider??""}><option value="">Select clinician</option>{[...ctx.providers.values()].map(p=><option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}</select></Field>
    <Field label="Location"><select name="location_id" className={inputClass} defaultValue={query.location??""}><option value="">No location</option>{[...ctx.locations.values()].map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
    <Field label="Authorization"><select name="authorization_id" className={inputClass}><option value="">None</option>{ctx.rows.authorizations.map(a=><option key={a.id} value={a.id}>{ctx.patients.get(a.patient_id)?.last_name} · {ctx.services.get(a.service_id)?.service_name} · ends {a.end_date}</option>)}</select></Field>
    <Field label="Start (patient local time)"><input required name="start_time" type="datetime-local" className={inputClass} defaultValue={query.start}/></Field>
    <Field label="Duration"><select required name="duration_minutes" className={inputClass} defaultValue={query.duration??"60"}>{[30,45,60,90,120,180].map(n=><option key={n} value={n}>{n} minutes</option>)}</select></Field>
    <Field label="Repeat"><select name="repeat_count" className={inputClass} defaultValue="1"><option value="1">One appointment</option><option value="4">Weekly · 4 weeks</option><option value="8">Weekly · 8 weeks</option><option value="12">Weekly · 12 weeks</option><option value="26">Weekly · 26 weeks</option></select></Field>
    <Field label="Protection"><select name="scheduling_flexibility" className={inputClass}><option>FLEXIBLE</option><option>PROTECTED</option><option>LOCKED</option></select></Field>
  </div><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="telehealth"/> Telehealth appointment</label><Field label="Internal note"><textarea name="notes" className={`${inputClass} min-h-24`}/></Field><button className="min-h-11 w-full rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white sm:w-auto">Check and book</button></form></Card></div>;
}
