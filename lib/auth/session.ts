import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Permission, Role, can, isRole } from "./roles";

/**
 * Demo sessions.
 *
 * ⚠ THIS IS NOT AUTHENTICATION. It is a role switcher that stores a role name
 * in a cookie so the role-aware UI can be built and reviewed before the client
 * has chosen an identity provider. Anyone can pick any role; nothing is
 * verified; there is no password.
 *
 * It exists so the permission model is exercised by real screens rather than
 * living only in a document. The permission checks themselves
 * (`requirePermission`, `navFor`) are the real thing and stay as they are when
 * authentication arrives.
 *
 * Before any real patient data, this file is replaced by:
 *   1. the client's identity provider (Microsoft 365 / Google / Okta) if they
 *      have one, or Supabase Auth if not;
 *   2. roles read from the database, not from a cookie the user controls;
 *   3. Postgres row-level security, so a therapist restricted to their own
 *      caseload is restricted at the database and not merely in the UI.
 */

const COOKIE_NAME = "bsh_demo_role";

export interface Session {
  role: Role;
  /** Display name for the demo user. Real sessions carry a real identity. */
  name: string;
  /**
   * The provider record this user *is*, when they are a clinician. This is
   * what makes "own schedule only" enforceable: without a link from the
   * account to a provider row, a scope of "own" has nothing to scope to.
   */
  providerId: string | null;
  /** Always true in Phase 1 — surfaced in the UI so nobody mistakes it. */
  demo: true;
}

const DEMO_IDENTITIES: Record<Role, { name: string; providerId: string | null }> = {
  SCHEDULER: { name: "Sam Okonjo", providerId: null },
  // A clinical supervisor is also a clinician with their own caseload.
  CLINICAL: { name: "Eve Nakamura", providerId: "prv-bcba-eve" },
  PROVIDER: { name: "Alice Moreau", providerId: "prv-rbt-alice" },
  AUTHORIZATION: { name: "Lena Fischer", providerId: null },
  OPERATIONS: { name: "Marcus Webb", providerId: null },
  ADMIN: { name: "Jo Tanaka", providerId: null },
  COMPLIANCE: { name: "Ruth Adeyemi", providerId: null },
};

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const role = store.get(COOKIE_NAME)?.value;
  if (!isRole(role)) return null;
  const identity = DEMO_IDENTITIES[role];
  return { role, name: identity.name, providerId: identity.providerId, demo: true };
}

/** Redirects to sign-in when there is no session. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Gate a page on a permission. Sends signed-out users to sign in, and signed-in
 * users without the permission to a page explaining what their role can do —
 * a dead end with no explanation is how people conclude software is broken.
 */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!can(session.role, permission)) {
    redirect(`/no-access?permission=${encodeURIComponent(permission)}`);
  }
  return session;
}

export const SESSION_COOKIE = COOKIE_NAME;
