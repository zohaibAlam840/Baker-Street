/**
 * The AI layer (spec sections 58-59).
 *
 * The spec is unambiguous about what this layer may and may not do:
 *
 *   AI may     translate a request into a structured scheduling request,
 *              and explain a result the engine produced.
 *   AI may NOT invent availability, decide whether a schedule is legal,
 *              write appointments, override authorization or credentials,
 *              or determine clinical necessity.
 *
 * So this module does exactly one thing: turn a sentence into a typed request
 * object. It never computes an answer. The request goes to the rule engine and
 * the Fill Service analysis, and whatever comes back is the truth — the
 * wording around it is presentation.
 *
 * ── Honest note on the implementation ──────────────────────────────────────
 * There is no language model wired up. This is a deterministic parser over a
 * small set of phrasings, which is enough to demonstrate the *architecture*:
 * request in, structured intent out, engine decides. Swapping in a real model
 * means replacing `interpret()` and nothing else — the boundary is the point,
 * not the parser.
 */

import type { ScheduleContext } from "../rules/context";
import type { UUID } from "../domain/types";

export type Intent =
  | "OPTIMIZE_PATIENT"
  | "FILL_SERVICE"
  | "CHECK_CAPACITY"
  | "WHAT_IF_HIRE"
  | "EXPLAIN_PATIENT"
  | "UNKNOWN";

export interface StructuredRequest {
  intent: Intent;
  patient_id?: UUID;
  patient_name?: string;
  service_id?: UUID;
  service_name?: string;
  target_hours?: number;
  protected_services?: UUID[];
  provider_type?: string;
  count?: number;
  /** Everything the parser could not account for. */
  unmatched: string[];
  /** How confident the parse is, for the UI to be honest about. */
  confidence: "high" | "low";
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Turn a sentence into a structured scheduling request. Never an answer. */
export function interpret(input: string, ctx: ScheduleContext): StructuredRequest {
  const text = input.toLowerCase().trim();
  const unmatched: string[] = [];

  // ---- which patient ------------------------------------------------------
  let patientId: UUID | undefined;
  let patientName: string | undefined;
  for (const patient of ctx.patients.values()) {
    const first = patient.first_name.toLowerCase();
    const full = `${patient.first_name} ${patient.last_name}`.toLowerCase();
    if (text.includes(full) || new RegExp(`\\b${first}\\b`).test(text)) {
      patientId = patient.id;
      patientName = `${patient.first_name} ${patient.last_name}`;
      break;
    }
  }

  // ---- which service ------------------------------------------------------
  let serviceId: UUID | undefined;
  let serviceName: string | undefined;
  const serviceAliases: { match: RegExp; id: UUID }[] = [];
  for (const service of ctx.services.values()) {
    serviceAliases.push({
      match: new RegExp(
        `\\b(${[
          service.service_name.toLowerCase(),
          service.service_code.toLowerCase().replace(/_/g, " "),
          service.service_code.toLowerCase().split("_")[0],
        ]
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})\\b`,
      ),
      id: service.id,
    });
  }
  for (const alias of serviceAliases) {
    if (alias.match.test(text)) {
      serviceId = alias.id;
      serviceName = ctx.services.get(alias.id)?.service_name;
      break;
    }
  }

  // ---- numbers ------------------------------------------------------------
  const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/);
  const bareNumber = text.match(/\b(\d+(?:\.\d+)?)\b/);
  const wordNumber = Object.keys(NUMBER_WORDS).find((w) =>
    new RegExp(`\\b${w}\\b`).test(text),
  );

  const targetHours = hoursMatch
    ? Number(hoursMatch[1])
    : bareNumber && /to|reach|up to|get/.test(text)
      ? Number(bareNumber[1])
      : undefined;

  // ---- protected services -------------------------------------------------
  const protectedServices: UUID[] = [];
  if (/(without|don'?t|do not|keep|preserve|not lose|no(?:t)? touch)/.test(text)) {
    for (const alias of serviceAliases) {
      if (alias.id === serviceId) continue;
      if (alias.match.test(text)) protectedServices.push(alias.id);
    }
  }

  // ---- intent -------------------------------------------------------------
  let intent: Intent = "UNKNOWN";

  if (/(hire|hiring|recruit|add|extra|more)\s+\w*\s*(rbt|bcba|therapist|ot\b|clinician)/.test(text)) {
    intent = "WHAT_IF_HIRE";
  } else if (/what (if|happens)/.test(text) && /(rbt|bcba|therapist|hire)/.test(text)) {
    intent = "WHAT_IF_HIRE";
  } else if (/(capacity|utilisation|utilization|how many .*(more|additional)|unused|unfilled)/.test(text)) {
    intent = "CHECK_CAPACITY";
  } else if (targetHours != null && (patientId || /patient/.test(text))) {
    intent = protectedServices.length > 0 ? "OPTIMIZE_PATIENT" : "FILL_SERVICE";
  } else if (/(why|explain|what.*stopping|can'?t|cannot|short)/.test(text) && patientId) {
    intent = "EXPLAIN_PATIENT";
  } else if (patientId && serviceId) {
    intent = "FILL_SERVICE";
  }

  // ---- hiring specifics ---------------------------------------------------
  let providerType: string | undefined;
  let count: number | undefined;
  if (intent === "WHAT_IF_HIRE") {
    const typeMatch = text.match(/\b(rbt|bcba|psychologist|neuropsychologist|lmhc|lcsw|ot|pt|slp)s?\b/);
    providerType = typeMatch ? typeMatch[1].toUpperCase() : "RBT";
    count = hoursMatch
      ? undefined
      : bareNumber
        ? Number(bareNumber[1])
        : wordNumber
          ? NUMBER_WORDS[wordNumber]
          : 1;
    if (!count || count > 20) count = Math.min(count ?? 1, 20);
  }

  // ---- what we could not place -------------------------------------------
  if (!patientId && (intent === "FILL_SERVICE" || intent === "OPTIMIZE_PATIENT")) {
    unmatched.push("no patient named");
  }
  if (!serviceId && intent !== "WHAT_IF_HIRE" && intent !== "CHECK_CAPACITY") {
    unmatched.push("no service named");
  }

  return {
    intent,
    patient_id: patientId,
    patient_name: patientName,
    service_id: serviceId,
    service_name: serviceName,
    target_hours: targetHours,
    protected_services: protectedServices.length > 0 ? protectedServices : undefined,
    provider_type: providerType,
    count,
    unmatched,
    confidence: intent === "UNKNOWN" || unmatched.length > 0 ? "low" : "high",
  };
}

/** Things the parser handles, shown on screen so nobody has to guess. */
export const EXAMPLE_REQUESTS = [
  "Get John to 30 hours of ABA this week without moving his OT or therapy",
  "How close can Kofi get to 20 hours of ABA?",
  "Why can't John reach 40 hours?",
  "What happens if we hire three more RBTs?",
  "How much unused authorization do we have?",
] as const;
