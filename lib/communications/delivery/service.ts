import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createCommunicationServiceClient(
  supabaseUrl: string,
  serviceRoleKey: string,
): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-client-info": "baker-street-communications-worker" } },
  });
}

