import Link from "next/link";

import { Card, CardHeader } from "@/components/charts";
import { requirePermission } from "@/lib/auth/session";
import { loadCompletedClaimDrafts } from "@/lib/integrations/claims/load";
import { claimsDateRange } from "@/lib/integrations/claims/range";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ start?: string; end?: string }> }) {
  await requirePermission("authorization.manage");
  const query = await searchParams;
  let range;
  try { range = claimsDateRange(query.start ?? null, query.end ?? null); }
  catch { range = claimsDateRange(null, null); }
  const drafts = await loadCompletedClaimDrafts(await createClient(), range.startDate, range.endDateExclusive);
  const ready = drafts.filter((draft) => draft.ready).length;
  const exportHref = `/api/integrations/claims/fhir?start=${range.startDate}&end=${range.endDateExclusive}`;
  return <div className="space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wide text-[var(--brand)]">Billing interoperability</p><h1 className="mt-1 text-2xl font-semibold">Claim readiness</h1><p className="mt-2 max-w-2xl text-sm text-[var(--ink-secondary)]">Completed visits are compiled into FHIR R4 Claim drafts. Missing payer, coding, identity, and diagnosis data blocks submission explicitly.</p></div><Link href={exportHref} className="button-secondary min-h-11 px-4">Download FHIR drafts</Link></header>
    <Card><form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><label className="text-xs font-medium">Start date<input type="date" name="start" defaultValue={range.startDate} className="mt-1 h-11 w-full rounded-xl border border-[var(--border-ring)] px-3"/></label><label className="text-xs font-medium">End date (exclusive)<input type="date" name="end" defaultValue={range.endDateExclusive} className="mt-1 h-11 w-full rounded-xl border border-[var(--border-ring)] px-3"/></label><button className="button-primary min-h-11 px-4">Review</button></form></Card>
    <div className="grid gap-3 sm:grid-cols-3"><Card><p className="text-xs text-[var(--ink-muted)]">Completed visits</p><p className="mt-1 text-2xl font-semibold">{drafts.length}</p></Card><Card><p className="text-xs text-[var(--ink-muted)]">Submission-ready</p><p className="mt-1 text-2xl font-semibold">{ready}</p></Card><Card><p className="text-xs text-[var(--ink-muted)]">Blocked drafts</p><p className="mt-1 text-2xl font-semibold">{drafts.length - ready}</p></Card></div>
    <Card><CardHeader title="Drafts and mapping gaps" sub="No claim is submitted from this screen"/>{drafts.length === 0 ? <p className="mt-4 text-sm text-[var(--ink-secondary)]">No completed appointments were found in this range.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[48rem] text-left text-sm"><thead className="text-xs text-[var(--ink-muted)]"><tr><th className="pb-2">Service date</th><th className="pb-2">Patient</th><th className="pb-2">Service</th><th className="pb-2">Payer</th><th className="pb-2">Readiness</th></tr></thead><tbody className="divide-y divide-[var(--rule-hairline)]">{drafts.map((draft) => <tr key={draft.appointmentId}><td className="py-3">{draft.startTime.slice(0,10)}</td><td className="py-3">{draft.patientName}</td><td className="py-3">{draft.serviceName}</td><td className="py-3">{draft.payer ?? "Missing"}</td><td className="py-3">{draft.ready ? <span className="text-green-700">Ready</span> : <span className="text-amber-800">{draft.gaps.map((gap) => gap.toLowerCase().replaceAll("_", " ")).join(", ")}</span>}</td></tr>)}</tbody></table></div>}</Card>
  </div>;
}
