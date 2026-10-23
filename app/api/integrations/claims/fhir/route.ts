import { NextResponse } from "next/server";

import { authorizeApi, isApiError } from "@/lib/auth/api";
import { claimDraftBundle } from "@/lib/integrations/claims/fhir";
import { loadCompletedClaimDrafts } from "@/lib/integrations/claims/load";
import { claimsDateRange } from "@/lib/integrations/claims/range";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizeApi("authorization.manage");
  if (isApiError(auth)) return auth;
  const url = new URL(request.url);
  let range;
  try { range = claimsDateRange(url.searchParams.get("start"), url.searchParams.get("end")); }
  catch { return NextResponse.json({ error: "Choose a valid range of at most 93 days." }, { status: 400 }); }
  try {
    const drafts = await loadCompletedClaimDrafts(await createClient(), range.startDate, range.endDateExclusive);
    return NextResponse.json(claimDraftBundle(drafts), {
      headers: {
        "content-type": "application/fhir+json; charset=utf-8",
        "content-disposition": `attachment; filename="claim-drafts-${range.startDate}-${range.endDateExclusive}.fhir.json"`,
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Claim drafts could not be generated." }, { status: 500 });
  }
}
