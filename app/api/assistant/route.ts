/**
 * POST /api/assistant
 *
 * What the chat widget talks to. A sentence goes in; the parser turns it into
 * a structured request, the engine answers it, and both halves come back so
 * the UI can show what was understood alongside what was computed.
 *
 * Gated on the same permission as the assistant page. The widget is only
 * rendered for roles that hold it, but a route that trusted that would be
 * trusting the client — the check lives here too.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeApi, isApiError } from "@/lib/auth/api";

import { answerQuestion } from "@/lib/ai/answer";
import { interpret } from "@/lib/ai/interpret";
import { can } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { loadHorizon } from "@/lib/data/snapshot";
import { defaultWeekStart } from "@/lib/scheduling/defaults";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizeApi("schedule.search_availability");
  if (isApiError(auth)) return auth;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!can(session.role, "schedule.search_availability")) {
    return NextResponse.json(
      { error: "Your role cannot search availability." },
      { status: 403 },
    );
  }

  let body: { q?: unknown; week?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = typeof body.q === "string" ? body.q.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "`q` is required." }, { status: 400 });
  }
  if (question.length > 400) {
    return NextResponse.json({ error: "Question too long." }, { status: 400 });
  }

  const week =
    typeof body.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.week)
      ? body.week
      : defaultWeekStart();

  const { ctx, synthetic } = await loadHorizon({ startDate: week });
  const understood = interpret(question, ctx);
  const answer = answerQuestion(ctx, understood);

  return NextResponse.json({
    understood: {
      intent: understood.intent,
      patient: understood.patient_name ?? null,
      service: understood.service_name ?? null,
      target_hours: understood.target_hours ?? null,
      protected_services:
        understood.protected_services?.map((id) => ctx.services.get(id)?.service_name) ?? null,
      provider_type: understood.provider_type ?? null,
      count: understood.count ?? null,
      confidence: understood.confidence,
    },
    answer,
    meta: { week, synthetic_data: synthetic },
  });
}
