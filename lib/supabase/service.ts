import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class ServiceClientConfigurationError extends Error {
  readonly code = "SERVICE_CLIENT_NOT_CONFIGURED";
}

export function createServiceClient(clientInfo: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new ServiceClientConfigurationError();

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-client-info": clientInfo } },
  });
}
