import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Permission, Role, can, isRole } from "./roles";

export interface Session {
  userId: string;
  email: string;
  role: Role;
  name: string;
  providerId: string | null;
  demo: false;
}

export async function getSession(): Promise<Session | null> {
  const supabase = await createClient();
  const { data: claimsData, error } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (error || !userId) return null;
  const { data: profile } = await supabase.from("user_profiles").select("display_name, role, provider_id, active").eq("user_id", userId).single();
  if (!profile?.active || !isRole(profile.role)) return null;
  return { userId, email: String(claimsData.claims.email ?? ""), role: profile.role, name: profile.display_name, providerId: profile.provider_id, demo: false };
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!can(session.role, permission)) redirect(`/no-access?permission=${encodeURIComponent(permission)}`);
  return session;
}
