/**
 * Creates deterministic development accounts for every role.
 * Requires server-only SUPABASE_SERVICE_ROLE_KEY and TEST_USER_PASSWORD.
 * Never put either value in a NEXT_PUBLIC variable or commit them.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.TEST_USER_PASSWORD;
if (!url || !serviceKey || !password || password.length < 12) {
  throw new Error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and TEST_USER_PASSWORD (12+ characters).");
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const uuidFor = (name: string) => {
  const h = createHash("sha1").update(`bsh:${name}`).digest("hex");
  const variant = ((parseInt(h.slice(16,18),16)&0x3f)|0x80).toString(16);
  return [h.slice(0,8),h.slice(8,12),`5${h.slice(13,16)}`,`${variant}${h.slice(18,20)}`,h.slice(20,32)].join("-");
};

const accounts = [
  ["scheduler@bakerstreet.test", "Sam Scheduler", "SCHEDULER", null],
  ["clinical@bakerstreet.test", "Eve Clinical", "CLINICAL", "prv-bcba-eve"],
  ["provider@bakerstreet.test", "Alice Provider", "PROVIDER", "prv-rbt-alice"],
  ["authorization@bakerstreet.test", "Lena Authorization", "AUTHORIZATION", null],
  ["operations@bakerstreet.test", "Marcus Operations", "OPERATIONS", null],
  ["admin@bakerstreet.test", "Jo Administrator", "ADMIN", null],
  ["compliance@bakerstreet.test", "Ruth Compliance", "COMPLIANCE", null],
] as const;

async function main() {
  const { data: listed, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw listError;
  const knownUsers = new Map(listed.users.map((item) => [item.email, item]));

  for (const [email, displayName, role, providerFixture] of accounts) {
    let user = knownUsers.get(email);
    if (!user) {
      const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: displayName, requested_role: role } });
      if (error) throw error;
      user = data.user;
      knownUsers.set(email, user);
    }
    const { error } = await supabase.from("user_profiles").upsert({ user_id: user.id, display_name: displayName, role, requested_role: role, provider_id: providerFixture ? uuidFor(providerFixture) : null, active: true, approved_at: new Date().toISOString(), approved_by: user.id }, { onConflict: "user_id" });
    if (error) throw error;
    console.log(`${role.padEnd(14)} ${email}`);
  }
}

main().catch((error: unknown) => {
  console.error("Account seed failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
