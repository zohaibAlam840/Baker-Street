/**
 * Turning a structured request into a *presentable* answer.
 *
 * `interpret()` decides which question was asked. This module asks the engine
 * and shapes what comes back into plain data — no JSX, no Next.js — so that
 * the chat widget and the full assistant page render the same numbers from the
 * same computation. Before this existed the page did the work inline and the
 * widget just navigated away; the two could drift, and a chat that answers by
 * redirecting is not a chat.
 *
 * The boundary from spec sections 58-59 still holds: every figure below is
 * produced by the scheduling engine. Nothing here invents availability,
 * decides legality, or books anything.
 */

import type { ScheduleContext } from "../rules/context";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotsToHours } from "../domain/slots";
import { formatClockTime } from "../domain/time";
import { FlatTravelModel } from "../rules/travel";
import { analyseFillService } from "../scheduling/fillService";
import { currentCapacity, simulateHiring } from "../scheduling/whatIf";
import type { ProviderType } from "../domain/types";
import type { StructuredRequest } from "./interpret";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface AnswerStat {
  label: string;
  value: string;
  /** Shown under the figure where the number alone would mislead. */
  hint?: string;
}

export interface AnswerLink {
  label: string;
  href: string;
}

export interface AnswerProposal {
  when: string;
  detail: string;
}

export interface AssistantAnswer {
  kind: "capacity" | "hiring" | "fill" | "unresolved";
  title: string;
  subtitle?: string;
  /** One or two sentences — this is what a chat bubble shows on its own. */
  summary: string;
  stats: AnswerStat[];
  proposals: AnswerProposal[];
  /** Ordered most-binding-first, straight from the engine. */
  blockers: string[];
  notes: string[];
  links: AnswerLink[];
  meta?: { runtime_ms: number; candidates: number; exact: boolean };
}

/** Ask the engine the question the parser identified. */
export function answerQuestion(
  ctx: ScheduleContext,
  request: StructuredRequest,
): AssistantAnswer {
  const week = ctx.grid.startDate;

  if (request.intent === "CHECK_CAPACITY") {
    const capacity = currentCapacity(ctx);
    return {
      kind: "capacity",
      title: "Capacity right now",
      subtitle: `Week of ${week}`,
      summary:
        `${capacity.schedulable_hours}h can actually be delivered this week. ` +
        `${capacity.unused_authorization}h of authorization is unused, but ` +
        `${capacity.unfillable}h of that has nobody free to deliver it — funded is not the same as available.`,
      stats: [
        { label: "Deliverable hours", value: `${capacity.schedulable_hours}h` },
        { label: "Unused authorization", value: `${capacity.unused_authorization}h` },
        {
          label: "Of which unstaffable",
          value: `${capacity.unfillable}h`,
          hint: "Funded, but no eligible clinician is free",
        },
        { label: "Patients with headroom", value: String(capacity.patients_with_headroom) },
      ],
      proposals: [],
      blockers: [],
      notes: [],
      links: [
        { label: "Capacity report", href: "/capacity" },
        { label: "Authorizations", href: "/authorizations" },
      ],
    };
  }

  if (request.intent === "WHAT_IF_HIRE") {
    const aba = [...ctx.services.values()].find((s) => s.service_code === "ABA_DIRECT");
    const result = simulateHiring(ctx, {
      providerType: (request.provider_type ?? "RBT") as ProviderType,
      count: request.count ?? 1,
      serviceId: aba?.id ?? [...ctx.services.values()][0].id,
    });

    return {
      kind: "hiring",
      title: result.label,
      subtitle: "Simulated — nothing was changed",
      summary:
        `That adds ${result.added_clinical_hours}h of clinician time, but only ` +
        `${result.additional_schedulable_hours}h more care reaches patients` +
        (result.wasted_hours > 0
          ? ` — ${result.wasted_hours}h would go unused, because patient availability and authorization bind before headcount does.`
          : "."),
      stats: [
        {
          label: "Extra hours delivered",
          value: `${result.additional_schedulable_hours}h`,
          hint: "What patients actually receive",
        },
        { label: "Clinician hours added", value: `${result.added_clinical_hours}h` },
        { label: "Of which unusable", value: `${result.wasted_hours}h` },
        { label: "Patients helped", value: String(result.patients_helped) },
      ],
      proposals: [],
      blockers: [],
      notes: result.notes,
      links: [{ label: "Run a fuller simulation", href: "/simulate" }],
    };
  }

  if (
    (request.intent === "FILL_SERVICE" ||
      request.intent === "OPTIMIZE_PATIENT" ||
      request.intent === "EXPLAIN_PATIENT") &&
    request.patient_id &&
    request.service_id
  ) {
    const analysis = analyseFillService(ctx, {
      patient_id: request.patient_id,
      service_id: request.service_id,
      target_hours: request.target_hours,
      travel: new FlatTravelModel(ctx.locations, { enforceAsHardConstraint: true }),
    });

    const firstName = request.patient_name?.split(" ")[0] ?? "This patient";
    const gained = analysis.achievable_additional_hours;

    // When they named a target the week cannot reach, lead with that. The
    // engine already knows why — those reasons are in `blockers` — but an
    // answer that reports 30h to someone who asked about 40h, without
    // mentioning the gap, reads as though it misheard the question.
    const short =
      analysis.target_hours != null && analysis.projected_hours < analysis.target_hours;

    const reached =
      gained > 0
        ? `an extra ${gained}h across ${analysis.proposed.length} ` +
          `${analysis.proposed.length === 1 ? "appointment" : "appointments"}. ` +
          (analysis.exact
            ? "No arrangement can do better."
            : `A better arrangement may exist, up to ${analysis.upper_bound_additional_hours}h.`)
        : `nothing more can be added this week. ` +
          (analysis.limiting_factors[0]?.message ?? "");

    const summary = short
      ? `${firstName} cannot reach ${analysis.target_hours} hours of ` +
        `${analysis.service_name} this week. The most they can reach is ` +
        `${analysis.projected_hours}h — ${reached}`
      : gained > 0
        ? `${firstName} can reach ${analysis.projected_hours} hours of ` +
          `${analysis.service_name} this week — ${reached}`
        : `${firstName} is at ${analysis.current_hours}h of ` +
          `${analysis.service_name} and ${reached}`;

    return {
      kind: "fill",
      title: `${request.patient_name}: ${analysis.service_name}`,
      subtitle: analysis.target_hours
        ? `${analysis.current_hours}h scheduled, target ${analysis.target_hours}h`
        : `${analysis.current_hours}h scheduled`,
      summary,
      stats: [
        { label: "Scheduled now", value: `${analysis.current_hours}h` },
        { label: "Reachable this week", value: `${analysis.projected_hours}h` },
        {
          label: "Added",
          value: `+${gained}h`,
          hint: analysis.exact ? "Provably the best available" : `Upper bound ${analysis.upper_bound_additional_hours}h`,
        },
      ],
      proposals: analysis.proposed.map((candidate) => {
        const day = Math.floor(candidate.start_slot / SLOTS_PER_DAY);
        const startMinutes = (candidate.start_slot % SLOTS_PER_DAY) * SLOT_MINUTES;
        const provider = ctx.providers.get(candidate.provider_id);
        return {
          when: `${WEEKDAYS[ctx.grid.weekdayOf(day)]} ${formatClockTime(startMinutes)}`,
          detail: `${slotsToHours(candidate.duration_slots)}h · ${
            provider ? `${provider.first_name} ${provider.last_name}` : "—"
          }`,
        };
      }),
      blockers: analysis.limiting_factors.map((factor) => factor.message),
      // Said out loud, because answering about a service nobody named would
      // otherwise look like the assistant knowing something it does not.
      notes: request.assumed_service
        ? [
            `You did not name a service, so I took ${analysis.service_name} — the one ${firstName} receives most of this week.`,
          ]
        : [],
      links: [
        { label: `${firstName}'s record`, href: `/patients/${request.patient_id}?week=${week}` },
        { label: "Optimize", href: "/optimize" },
      ],
      meta: {
        runtime_ms: analysis.meta.runtime_ms,
        candidates: analysis.meta.candidates_considered,
        exact: analysis.exact,
      },
    };
  }

  return {
    kind: "unresolved",
    title: "I could not turn that into a scheduling request",
    summary:
      (request.intent !== "UNKNOWN" && request.unmatched.length > 0
        ? `I am missing ${request.unmatched.join(" and ")}. `
        : "I did not recognise an intent in that. ") +
      "This is a fixed-phrase parser, not open language — try one of the examples.",
    stats: [],
    proposals: [],
    blockers: [],
    notes: [],
    links: [],
  };
}
