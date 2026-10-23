"use server";

import { redirect } from "next/navigation";

import { normalizeEmail } from "@/lib/communications/validation";
import { createClient } from "@/lib/supabase/server";
import { guardianPortalEnabled } from "./config";

function result(key: "error" | "notice", message: string): never {
  redirect(`/portal/login?${key}=${encodeURIComponent(message)}`);
}

export async function requestGuardianPortalLink(form: FormData) {
  let enabled = false;
  try { enabled = guardianPortalEnabled(); } catch { /* handled as unavailable */ }
  if (!enabled) result("error", "Guardian access is not enabled for this organization.");
  const email = normalizeEmail(String(form.get("email") ?? ""));
  if (!email) result("error", "Enter a valid email address.");
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (!siteUrl) result("error", "Guardian sign-in is temporarily unavailable.");
  const supabase = await createClient();
  await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${siteUrl}/auth/callback?next=/portal`,
    },
  });
  result("notice", "If this email has approved guardian access, a secure sign-in link has been sent.");
}

export async function guardianPortalSignOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/portal/login");
}
