import { buildAppleAppSiteAssociation } from "@/lib/mobile/associations";
import { readMobileAssociationConfig } from "@/lib/mobile/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const document = buildAppleAppSiteAssociation(readMobileAssociationConfig());
    if (!document) return new Response(null, { status: 404 });
    return Response.json(document, {
      headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" },
    });
  } catch {
    return Response.json({ error: "Mobile universal links are not configured." }, { status: 503 });
  }
}

