import Link from "next/link";
import { approveUser } from "@/lib/auth/actions";
import { requirePermission } from "@/lib/auth/session";
import { ROLES, ROLE_DEFINITIONS, isRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requirePermission("users.manage");
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: users }, { data: providers }] = await Promise.all([
    supabase.from("user_profiles").select("user_id,display_name,role,requested_role,provider_id,active,created_at").order("created_at", { ascending: false }),
    supabase.from("providers").select("id,first_name,last_name,provider_type,status").eq("status", "ACTIVE").order("last_name"),
  ]);

  return <div className="space-y-5">
    <div><Link href="/configuration" className="text-xs underline underline-offset-4">← Configuration</Link><h1 className="mt-2 text-xl font-semibold">Users and roles</h1><p className="text-sm text-[var(--ink-secondary)]">Approve access and link clinical accounts to the staff record that defines their scope.</p></div>
    {params.error && <p role="alert" className="rounded-lg bg-[var(--surface-sunken)] p-3 text-sm text-[var(--status-critical)]">{params.error}</p>}
    {params.notice && <p role="status" className="rounded-lg bg-[var(--brand-tint)] p-3 text-sm">{params.notice}</p>}
    <div className="space-y-3">{(users ?? []).map(user => {
      const requested = isRole(user.requested_role) ? user.requested_role : isRole(user.role) ? user.role : "PROVIDER";
      return <article key={user.user_id} className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-medium">{user.display_name}</h2><span className="rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[0.65rem]">{user.active ? "Active" : "Pending"}</span></div><p className="mt-1 text-xs text-[var(--ink-secondary)]">Current: {ROLE_DEFINITIONS[user.role as keyof typeof ROLE_DEFINITIONS]?.label ?? user.role} · requested: {ROLE_DEFINITIONS[requested].label}</p></div></div>
        <form action={approveUser} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
          <input type="hidden" name="user_id" value={user.user_id}/>
          <label className="text-xs text-[var(--ink-secondary)]"><span className="mb-1 block">Role</span><select name="role" defaultValue={requested} className={control}>{ROLES.map(r => <option key={r} value={r}>{ROLE_DEFINITIONS[r].label}</option>)}</select></label>
          <label className="text-xs text-[var(--ink-secondary)]"><span className="mb-1 block">Linked clinician</span><select name="provider_id" defaultValue={user.provider_id ?? ""} className={control}><option value="">Not a clinical account</option>{(providers ?? []).map(p => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} · {p.provider_type}</option>)}</select></label>
          <button className="min-h-11 rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white">{user.active ? "Update" : "Approve"}</button>
        </form>
      </article>})}{users?.length === 0 && <p className="card p-5 text-sm text-[var(--ink-secondary)]">No accounts have been created yet.</p>}</div>
  </div>;
}

const control = "min-h-11 w-full rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--ink-primary)]";
