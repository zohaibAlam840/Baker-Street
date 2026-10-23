import { NextResponse } from "next/server";

import { authorizeApi, isApiError } from "@/lib/auth/api";
import { fetchFhirCapability } from "@/lib/integrations/ehr/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await authorizeApi("config.services");
  if (isApiError(auth)) return auth;
  try {
    const capability = await fetchFhirCapability();
    if (!capability) return NextResponse.json({ status: "unconfigured" });
    return NextResponse.json({ status: "available", ...capability });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
