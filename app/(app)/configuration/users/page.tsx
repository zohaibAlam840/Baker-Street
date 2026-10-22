import Link from "next/link";

import { ActionSubmit } from "@/components/forms/ActionSubmit";
import { Field, inputClass } from "@/components/forms/PrototypeForm";
import { manageUserAccess } from "@/lib/auth/actions";
import { ROLES, ROLE_DEFINITIONS, isRole } from "@/lib/auth/roles";
import { requirePermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface UserProfile {
  user_id: string;
  display_name: string;
  role: string;
  requested_role: string | null;
  provider_id: string | null;
  active: boolean;
  version: number;
  created_at: string;
  approved_at: string | null;
  updated_at: string;
  access_changed_at: string | null;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [session, params] = await Promise.all([
    requirePermission("users.manage"),
    searchParams,
  ]);
  const supabase = await createClient();
  const [usersResult, providersResult] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("user_id,display_name,role,requested_role,provider_id,active,version,created_at,approved_at,updated_at,access_changed_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("providers")
      .select("id,first_name,last_name,provider_type,status")
      .eq("status", "ACTIVE")
      .order("last_name"),
  ]);
  if (usersResult.error || providersResult.error) {
    throw new Error("User access records could not be loaded safely.");
  }

  const users = (usersResult.data ?? []) as UserProfile[];
  const providers = providersResult.data ?? [];
  const pending = users.filter((user) => !user.active && !user.approved_at).length;
  const inactive = users.filter((user) => !user.active && user.approved_at).length;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/configuration" className="text-xs text-[var(--ink-secondary)] underline underline-offset-4">← Configuration</Link>
        <h1 className="mt-2 text-xl font-semibold text-[var(--ink-primary)]">Users and roles</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
          Approve, update, deactivate, or reactivate access. Every decision requires a reason and is retained in the audit log.
        </p>
      </div>

      {params.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{params.error}</p>}
      {params.notice && <p role="status" className="rounded-xl bg-[var(--brand-tint)] p-3 text-sm text-[var(--ink-primary)]">{params.notice}</p>}

      <dl className="grid grid-cols-3 gap-3">
        <Summary label="Active" value={users.length - pending - inactive} />
        <Summary label="Pending" value={pending} />
        <Summary label="Inactive" value={inactive} />
      </dl>

      <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
        Deactivation takes effect on the account&apos;s next authenticated request. Administrators cannot change their own role or status, and the last active administrator is protected.
      </p>

      <div className="space-y-3">
        {users.map((user) => {
          const requested = isRole(user.requested_role)
            ? user.requested_role
            : isRole(user.role)
              ? user.role
              : "PROVIDER";
          const status = user.active ? "Active" : user.approved_at ? "Inactive" : "Pending";
          const ownAccount = user.user_id === session.userId;
          return (
            <article key={user.user_id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-medium text-[var(--ink-primary)]">{user.display_name}</h2>
                    <StatusBadge status={status} />
                    {ownAccount && <span className="rounded-full bg-[var(--brand-tint)] px-2 py-1 text-[0.65rem] font-medium text-[var(--brand)]">Your account</span>}
                  </div>
                  <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                    Current: {isRole(user.role) ? ROLE_DEFINITIONS[user.role].label : user.role}
                    {!user.active && ` · requested: ${ROLE_DEFINITIONS[requested].label}`}
                    {` · version ${user.version}`}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    Created {new Date(user.created_at).toLocaleString()}
                    {user.access_changed_at && ` · access changed ${new Date(user.access_changed_at).toLocaleString()}`}
                  </p>
                </div>
              </div>

              {ownAccount ? (
                <p className="mt-4 rounded-xl bg-[var(--surface-sunken)] p-3 text-xs text-[var(--ink-secondary)]">
                  Another active administrator must change this account&apos;s role or status. This prevents accidental self-lockout.
                </p>
              ) : (
                <form action={manageUserAccess} className="mt-4 space-y-4 border-t border-[var(--rule-hairline)] pt-4">
                  <input type="hidden" name="user_id" value={user.user_id} />
                  <input type="hidden" name="expected_version" value={user.version} />
                  <input type="hidden" name="command_id" value={crypto.randomUUID()} />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Role">
                      <select name="role" defaultValue={user.active && isRole(user.role) ? user.role : requested} className={inputClass}>
                        {ROLES.map((role) => <option key={role} value={role}>{ROLE_DEFINITIONS[role].label}</option>)}
                      </select>
                    </Field>
                    <Field label="Access status">
                      <select name="status" defaultValue={user.active ? "ACTIVE" : user.approved_at ? "INACTIVE" : "ACTIVE"} className={inputClass}>
                        <option value="ACTIVE">Active</option>
                        <option value="INACTIVE">Inactive</option>
                      </select>
                    </Field>
                    <Field label="Linked clinician" hint="Required for active Provider accounts; optional for Clinical.">
                      <select name="provider_id" defaultValue={user.provider_id ?? ""} className={inputClass}>
                        <option value="">Not linked</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.last_name}, {provider.first_name} · {provider.provider_type}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Access decision reason" hint="Retained in permanent audit history; do not include patient information.">
                    <textarea required minLength={3} maxLength={500} name="reason" className={`${inputClass} min-h-20`} placeholder="Why is this role and status appropriate?" />
                  </Field>
                  <label className="flex min-h-11 items-start gap-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">
                    <input required name="confirmed" type="checkbox" className="mt-0.5 size-4" />
                    <span>I reviewed the role, clinician link, and access status. I understand deactivation blocks the account on its next authenticated request.</span>
                  </label>
                  <ActionSubmit pendingLabel="Saving access…">Save access decision</ActionSubmit>
                </form>
              )}
            </article>
          );
        })}
        {users.length === 0 && <p className="card p-5 text-sm text-[var(--ink-secondary)]">No accounts have been created yet.</p>}
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--rule-hairline)] bg-[var(--surface-1)] p-3 text-center">
      <dt className="text-xs text-[var(--ink-secondary)]">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-[var(--ink-primary)]">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: "Active" | "Pending" | "Inactive" }) {
  const tone = status === "Active"
    ? "bg-emerald-50 text-emerald-800"
    : status === "Pending"
      ? "bg-amber-50 text-amber-900"
      : "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]";
  return <span className={`rounded-full px-2 py-1 text-[0.65rem] font-medium ${tone}`}>{status}</span>;
}
