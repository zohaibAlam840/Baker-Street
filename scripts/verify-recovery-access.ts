/**
 * Read-only linked-project smoke check for the seven seeded application roles.
 * Uses only the publishable key and each account's normal password.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const password = process.env.TEST_USER_PASSWORD;

if (!url || !key || !password) {
  throw new Error("Set the Supabase URL, publishable key, and TEST_USER_PASSWORD before running this check.");
}

const accounts = [
  ["SCHEDULER", "scheduler@bakerstreet.test"],
  ["CLINICAL", "clinical@bakerstreet.test"],
  ["PROVIDER", "provider@bakerstreet.test"],
  ["AUTHORIZATION", "authorization@bakerstreet.test"],
  ["OPERATIONS", "operations@bakerstreet.test"],
  ["ADMIN", "admin@bakerstreet.test"],
  ["COMPLIANCE", "compliance@bakerstreet.test"],
] as const;

async function main() {
  const anonymous = createClient(url!, key!, { auth: { persistSession: false } });
  const { data: schema, error: schemaError } = await anonymous.rpc("app_schema_status");
  if (
    schemaError
    || schema?.version !== "20261022040000"
    || schema?.optimizer_moves !== true
    || schema?.optimizer_decisions !== true
    || schema?.clinical_reductions !== true
    || schema?.provider_time_off !== true
    || schema?.provider_callout_guard !== true
    || schema?.access_management !== true
    || schema?.schedule_recovery !== true
    || schema?.communications !== true
    || schema?.communication_delivery !== true
    || schema?.configuration_writes !== true
  ) {
    throw new Error("The linked database does not report recovery, communications delivery, configuration writes, optimizer decisions and moves, clinical reduction review, provider time off, the self-reported callout guard, and guarded access management as ready.");
  }

  for (const [expectedRole, email] of accounts) {
    const client = createClient(url!, key!, { auth: { persistSession: false } });
    const { data: auth, error: authError } = await client.auth.signInWithPassword({
      email,
      password: password!,
    });
    if (authError || !auth.user) {
      throw new Error(`${expectedRole} test account could not sign in.`);
    }

    const [{ data: currentRole, error: roleError }, { data: profile, error: profileError }] = await Promise.all([
      client.rpc("current_app_role"),
      client
        .from("user_profiles")
        .select("role, active")
        .eq("user_id", auth.user.id)
        .single(),
    ]);
    if (
      roleError
      || profileError
      || currentRole !== expectedRole
      || profile?.role !== expectedRole
      || profile.active !== true
    ) {
      throw new Error(`${expectedRole} test account has an incorrect or inactive profile.`);
    }

    await client.auth.signOut();
    console.log(`${expectedRole.padEnd(14)} authentication and profile role verified`);
  }

  console.log("Required schema capabilities and all seven seeded roles verified read-only.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Recovery access verification failed.");
  process.exit(1);
});
