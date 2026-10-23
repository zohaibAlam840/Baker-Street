import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeAuthNext } from "@/lib/auth/redirects";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeAuthNext(url.searchParams.get("next"));
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (next !== "/reset-password" && !next.startsWith("/portal")) {
        const { data: claims } = await supabase.auth.getClaims();
        const userId = claims?.claims?.sub;
        if (userId) {
          const { data: profile } = await supabase
            .from("user_profiles")
            .select("active")
            .eq("user_id", userId)
            .maybeSingle();
          if (!profile?.active) return NextResponse.redirect(new URL("/account/pending", url.origin));
        }
      }
      return NextResponse.redirect(new URL(next, url.origin));
    }
  }
  return NextResponse.redirect(new URL("/login?error=Authentication%20link%20is%20invalid%20or%20expired.", url.origin));
}
