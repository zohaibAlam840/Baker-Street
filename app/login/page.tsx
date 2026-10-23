import Link from "next/link";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { IconLogo } from "@/components/shell/icons";
import { signIn, signInWithEnterpriseSso } from "@/lib/auth/actions";
import { readEnterpriseSsoConfig } from "@/lib/auth/sso";

export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams;
  let sso = null;
  try { sso = readEnterpriseSsoConfig(); } catch { /* Deployment validation reports the configuration error. */ }
  return <AuthShell title="Welcome back" subtitle="Sign in to Baker Street Scheduling.">
    {error && <Alert tone="error">{error}</Alert>}{notice && <Alert>{notice}</Alert>}
    <form action={signIn} className="mt-6 space-y-4">
      <Field label="Work email"><input required type="email" name="email" autoComplete="email" className={field}/></Field>
      <Field label="Password" aside={<Link href="/forgot-password" className="underline underline-offset-4">Forgot password?</Link>}><input required type="password" name="password" autoComplete="current-password" className={field}/></Field>
      <AuthSubmitButton
        className={primary}
        pendingLabel="Signing you in…"
        pendingDescription="Checking your account and loading your secure workspace."
      >
        Sign in
      </AuthSubmitButton>
    </form>
    {sso && <>
      <div className="my-5 flex items-center gap-3 text-xs text-[var(--ink-muted)]"><span className="h-px flex-1 bg-[var(--rule-hairline)]"/><span>or</span><span className="h-px flex-1 bg-[var(--rule-hairline)]"/></div>
      <form action={signInWithEnterpriseSso}>
        <AuthSubmitButton
          className="h-11 w-full rounded-full border border-[var(--border-ring)] bg-[var(--surface-1)] text-sm font-medium text-[var(--ink-primary)]"
          pendingLabel="Opening secure sign-in…"
          pendingDescription="Redirecting to your organization’s identity provider."
        >
          Continue with {sso.label}
        </AuthSubmitButton>
      </form>
    </>}
    <p className="mt-5 text-center text-sm text-[var(--ink-secondary)]">Need an account? <Link href="/signup" className="font-medium text-[var(--brand)] underline underline-offset-4">Request access</Link></p>
  </AuthShell>;
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <main className="grid min-h-dvh bg-[var(--surface-1)] lg:grid-cols-[0.9fr_1.1fr]"><section className="hidden bg-[var(--brand)] p-12 text-white lg:flex lg:flex-col lg:justify-between"><div><Link href="/" className="flex items-center gap-2"><IconLogo className="size-8"/><span className="font-semibold">Baker Street</span></Link><h2 className="mt-20 max-w-md text-4xl font-semibold leading-tight">One secure place for scheduling, clinical capacity, and human-approved decisions.</h2><p className="mt-4 max-w-md text-sm leading-relaxed text-white/75">Access is assigned by role and every clinical change will be validated and audited.</p></div><p className="text-xs text-white/60">Seven roles · least-privilege access · protected scheduling data</p></section><section className="flex items-center justify-center p-6 sm:p-10"><div className="w-full max-w-md"><Link href="/" className="mb-10 flex items-center gap-2 lg:hidden"><IconLogo className="size-7 text-[var(--brand)]"/><span className="font-semibold">Baker Street</span></Link><h1 className="text-3xl font-semibold tracking-tight text-[var(--ink-primary)]">{title}</h1><p className="mt-2 text-sm text-[var(--ink-secondary)]">{subtitle}</p>{children}</div></section></main> }
export function Field({label,aside,children}:{label:string;aside?:React.ReactNode;children:React.ReactNode}){return <label className="block"><span className="mb-1.5 flex justify-between text-xs font-medium text-[var(--ink-secondary)]"><span>{label}</span>{aside}</span>{children}</label>}
export function Alert({children,tone="notice"}:{children:React.ReactNode;tone?:"notice"|"error"}){return <p role="status" className="mt-5 rounded-xl p-3 text-sm" style={{background:tone==="error"?"color-mix(in srgb, var(--status-critical) 10%, transparent)":"var(--brand-tint)",color:tone==="error"?"var(--status-critical)":"var(--ink-secondary)"}}>{children}</p>}
export const field="h-11 w-full rounded-xl border border-[var(--border-ring)] bg-[var(--surface-1)] px-3.5 text-sm outline-none focus:ring-2 focus:ring-[var(--brand-ring)]";
export const primary="h-11 w-full rounded-full bg-[var(--brand)] text-sm font-medium text-white hover:bg-[var(--brand-hover)]";
