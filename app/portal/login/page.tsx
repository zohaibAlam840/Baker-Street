import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { IconLogo } from "@/components/shell/icons";
import { requestGuardianPortalLink } from "@/lib/portal/actions";
import { guardianPortalEnabled } from "@/lib/portal/config";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function GuardianLoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims?.sub) redirect("/portal");
  const query = await searchParams;
  let enabled = false;
  try { enabled = guardianPortalEnabled(); } catch { /* deployment validation reports this */ }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--surface-1)] p-6">
      <section className="card w-full max-w-md p-7">
        <Link href="/" className="flex items-center gap-2 text-[var(--brand)]"><IconLogo className="size-8"/><span className="font-semibold">Baker Street</span></Link>
        <p className="mt-8 text-xs font-medium uppercase tracking-wide text-[var(--brand)]">Family access</p>
        <h1 className="mt-2 text-2xl font-semibold">Guardian portal</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">Use the email address that the scheduling team approved for your legal-guardian record. The link expires and access can be revoked at any time.</p>
        {query.error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{query.error}</p>}
        {query.notice && <p role="status" className="mt-4 rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{query.notice}</p>}
        {enabled ? (
          <form action={requestGuardianPortalLink} className="mt-6 space-y-4">
            <label className="block"><span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">Approved email</span><input required name="email" type="email" autoComplete="email" className="h-11 w-full rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 text-sm outline-none focus:ring-2 focus:ring-[var(--brand-ring)]"/></label>
            <AuthSubmitButton className="h-11 w-full rounded-full bg-[var(--brand)] text-sm font-medium text-white" pendingLabel="Sending secure link…" pendingDescription="Checking the sign-in service without revealing whether an address is registered.">Email me a secure link</AuthSubmitButton>
          </form>
        ) : <p className="mt-6 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Guardian access has not been activated by this organization.</p>}
        <p className="mt-6 text-center text-xs text-[var(--ink-muted)]">Staff member? <Link href="/login" className="underline underline-offset-4">Use staff sign-in</Link></p>
      </section>
    </main>
  );
}
