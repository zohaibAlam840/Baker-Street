"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { recordOperationalEvent } from "@/lib/observability/events";
import { logEvent } from "@/lib/observability/logger";
import { requirePermission } from "./session";
import { ROLE_DEFINITIONS, isRole } from "./roles";
import { readEnterpriseSsoConfig } from "./sso";

const message = (path: string, key: string, value: string) => `${path}?${key}=${encodeURIComponent(value)}`;

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const supabase = await createClient();
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !auth.user) {
    logEvent("warn", "auth.sign_in_failed", {
      error_code: error?.code ?? "INVALID_CREDENTIALS",
    });
    await recordOperationalEvent("AUTH_SIGN_IN_FAILED");
    redirect(message("/login", "error", "Email or password is incorrect."));
  }
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role, active")
    .eq("user_id", auth.user.id)
    .single();
  if (!profile?.active) redirect("/account/pending");
  if (!isRole(profile.role)) redirect(message("/login", "error", "Your account has no valid role."));
  redirect(ROLE_DEFINITIONS[profile.role].home);
}

export async function signInWithEnterpriseSso() {
  let config;
  try {
    config = readEnterpriseSsoConfig();
  } catch {
    redirect(message("/login", "error", "Enterprise sign-in is not configured correctly."));
  }
  if (!config) redirect(message("/login", "error", "Enterprise sign-in is not enabled."));
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!siteUrl) redirect(message("/login", "error", "Enterprise sign-in is not configured correctly."));

  const supabase = await createClient();
  const selector = config.providerId
    ? { providerId: config.providerId }
    : { domain: config.domain! };
  const { data, error } = await supabase.auth.signInWithSSO({
    ...selector,
    options: {
      redirectTo: `${siteUrl.replace(/\/$/, "")}/auth/callback?next=/dashboard`,
      skipBrowserRedirect: true,
    },
  });
  if (error || !data?.url) {
    logEvent("warn", "auth.sso_start_failed", { error_code: error?.code ?? "SSO_START_FAILED" });
    await recordOperationalEvent("AUTH_SIGN_IN_FAILED");
    redirect(message("/login", "error", "Enterprise sign-in could not be started."));
  }
  let destination: URL;
  try {
    destination = new URL(data.url);
  } catch {
    redirect(message("/login", "error", "Enterprise sign-in returned an invalid destination."));
  }
  if (destination.protocol !== "https:" && destination.hostname !== "127.0.0.1" && destination.hostname !== "localhost") {
    redirect(message("/login", "error", "Enterprise sign-in returned an unsafe destination."));
  }
  redirect(destination.toString());
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

export async function manageUserAccess(formData: FormData) {
  const session = await requirePermission("users.manage");
  const path = "/configuration/users";
  const userId = String(formData.get("user_id") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const providerId = String(formData.get("provider_id") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const expectedVersion = Number(formData.get("expected_version"));
  const commandId = String(formData.get("command_id") ?? "").trim();

  if (
    !userId
    || !isRole(role)
    || !["ACTIVE", "INACTIVE"].includes(status)
    || !Number.isInteger(expectedVersion)
    || expectedVersion < 1
    || reason.length < 3
    || reason.length > 500
    || !/^[A-Za-z0-9_-]{8,80}$/.test(commandId)
    || formData.get("confirmed") !== "on"
  ) {
    redirect(message(path, "error", "Choose a role and status, add a reason, confirm the decision, and try again."));
  }
  if (status === "ACTIVE" && role === "PROVIDER" && !providerId) {
    redirect(message(path, "error", "Active provider accounts must be linked to a clinician record."));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("manage_user_access", {
    p_target_user_id: userId,
    p_expected_version: expectedVersion,
    p_role: role,
    p_provider_id: role === "PROVIDER" || role === "CLINICAL" ? providerId : null,
    p_active: status === "ACTIVE",
    p_reason: reason,
    p_idempotency_key: `user-access:${session.userId}:${commandId}`,
  });
  if (error) {
    const lower = error.message.toLowerCase();
    const safe = lower.includes("changed; refresh")
      ? "This account changed while you were reviewing it. Refresh and try again."
      : lower.includes("last active administrator")
        ? "The last active administrator cannot be removed. Approve another administrator first."
        : lower.includes("their own role")
          ? "Use another administrator account to change your own role or access status."
          : lower.includes("linked clinician") || lower.includes("provider accounts")
            ? error.message
            : lower.includes("duplicate key")
              ? "That clinician is already linked to another active account."
              : "The access decision could not be saved. Refresh and try again.";
    redirect(message(path, "error", safe));
  }

  const result = data as { status?: string; already_applied?: boolean } | null;
  revalidatePath(path);
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  const notice = result?.already_applied
    ? "This access decision was already saved."
    : result?.status === "ACTIVE"
      ? "User access activated and audited."
      : "User access deactivated and audited.";
  redirect(message(path, "notice", notice));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
