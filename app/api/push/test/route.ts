import webpush from "web-push";
import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api";
import { recordOperationalEvent } from "@/lib/observability/events";
import { logEvent } from "@/lib/observability/logger";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return NextResponse.json({ error: "Push is not configured." }, { status: 503 });
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("enabled", true);
  if (error) {
    logEvent("error", "push.subscriptions_unavailable", {
      error_code: error.code ?? "PUSH_SUBSCRIPTIONS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "Push subscriptions are unavailable." }, { status: 503 });
  }

  let delivered = 0;
  let failed = 0;
  let removed = 0;
  for (const item of data ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
        JSON.stringify({
          title: "Baker Street notifications are ready",
          body: "You will receive important work-queue alerts on this device.",
          href: "/notifications",
        }),
      );
      delivered += 1;
    } catch (sendError) {
      const status = (sendError as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        const { error: deleteError } = await supabase
          .from("push_subscriptions")
          .delete()
          .eq("id", item.id);
        if (!deleteError) removed += 1;
        else failed += 1;
      } else {
        failed += 1;
      }
    }
  }

  if (failed > 0) await recordOperationalEvent("PUSH_DELIVERY_FAILED", failed);
  logEvent(failed > 0 ? "warn" : "info", "push.test_completed", {
    attempted: data?.length ?? 0,
    delivered,
    failed,
    removed,
  });
  return NextResponse.json({ ok: failed === 0, delivered, failed, removed });
}
