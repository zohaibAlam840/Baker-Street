"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ROLE_DEFINITIONS, isRole } from "./roles";

const message = (path: string, key: string, value: string) => `${path}?${key}=${encodeURIComponent(value)}`;

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(message("/login", "error", "Email or password is incorrect."));
  const { data: profile } = await supabase.from("user_profiles").select("role, active").single();
  if (!profile?.active) redirect("/account/pending");
  if (!isRole(profile.role)) redirect(message("/login", "error", "Your account has no valid role."));
  redirect(ROLE_DEFINITIONS[profile.role].home);
}

export async function signUp(formData: FormData) {
  const displayName = String(formData.get("display_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");
  const requestedRole = String(formData.get("requested_role") ?? "PROVIDER");
  if (!displayName || !email || password.length < 8) redirect(message("/signup", "error", "Enter your name, work email, and a password of at least 8 characters."));
  if (password !== confirm) redirect(message("/signup", "error", "Passwords do not match."));
  if (!isRole(requestedRole)) redirect(message("/signup", "error", "Select a valid role."));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName, requested_role: requestedRole } } });
  if (error) redirect(message("/signup", "error", error.message));
  if (!data.session) redirect(message("/login", "notice", "Account created. Check your email if confirmation is enabled."));
  redirect("/account/pending");
}

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const origin = (await headers()).get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/reset-password` });
  redirect(message("/forgot-password", "notice", "If that account exists, a password reset link has been sent."));
}

export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");
  if (password.length < 8 || password !== confirm) redirect(message("/reset-password", "error", "Passwords must match and contain at least 8 characters."));
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect(message("/reset-password", "error", error.message));
  redirect(message("/login", "notice", "Password updated. You can sign in now."));
}

export async function bootstrapAdmin() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("bootstrap_first_admin");
  if (error || !data) redirect(message("/account/pending", "error", "An administrator already exists or setup could not be completed."));
  redirect("/dashboard");
}

export async function approveUser(formData: FormData) {
  const userId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  const providerId = String(formData.get("provider_id") ?? "") || null;
  if (!userId || !isRole(role)) redirect(message("/configuration/users", "error", "Invalid user or role."));
  const supabase = await createClient();
  const { data: own } = await supabase.from("user_profiles").select("role, active").eq("user_id", (await supabase.auth.getClaims()).data?.claims?.sub ?? "").single();
  if (!own?.active || own.role !== "ADMIN") redirect("/no-access");
  if (role === "PROVIDER" && !providerId) redirect(message("/configuration/users", "error", "Provider accounts must be linked to a clinician record."));
  const linkedProvider = role === "PROVIDER" || role === "CLINICAL" ? providerId : null;
  const { error } = await supabase.from("user_profiles").update({ role, provider_id: linkedProvider, active: true, approved_at: new Date().toISOString(), approved_by: (await supabase.auth.getClaims()).data?.claims?.sub }).eq("user_id", userId);
  if (error) redirect(message("/configuration/users", "error", error.message));
  redirect(message("/configuration/users", "notice", "User access approved."));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
