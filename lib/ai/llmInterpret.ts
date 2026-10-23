import type { UUID } from "../domain/types";
import { logEvent } from "../observability/logger";
import type { ScheduleContext } from "../rules/context";
import { interpret, type Intent, type StructuredRequest } from "./interpret";
import { readLlmAssistantConfig } from "./llmConfig";

const INTENTS: Intent[] = ["OPTIMIZE_PATIENT", "FILL_SERVICE", "CHECK_CAPACITY", "WHAT_IF_HIRE", "EXPLAIN_PATIENT", "UNKNOWN"];

interface EntityMap {
  prompt: string;
  patients: Map<string, { id: UUID; name: string }>;
  services: Map<string, { id: UUID; name: string }>;
}

function escaped(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function deidentifyAssistantQuestion(input: string, ctx: ScheduleContext): EntityMap {
  let prompt = input;
  const patients = new Map<string, { id: UUID; name: string }>();
  const firstNameCounts = new Map<string, number>();
  for (const patient of ctx.patients.values()) {
    const first = patient.first_name.toLowerCase();
    firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
  }
  [...ctx.patients.values()].forEach((patient, index) => {
    const token = `PATIENT_${index + 1}`;
    const name = `${patient.first_name} ${patient.last_name}`;
    patients.set(token, { id: patient.id, name });
    prompt = prompt.replace(new RegExp(`\\b${escaped(name)}\\b`, "gi"), token);
    if (firstNameCounts.get(patient.first_name.toLowerCase()) === 1) {
      prompt = prompt.replace(new RegExp(`\\b${escaped(patient.first_name)}\\b`, "gi"), token);
    }
  });
  const services = new Map<string, { id: UUID; name: string }>();
  [...ctx.services.values()].forEach((service, index) => {
    const token = `SERVICE_${index + 1}`;
    services.set(token, { id: service.id, name: service.service_name });
    for (const alias of [service.service_name, service.service_code.replaceAll("_", " "), service.service_code, service.service_code.split("_")[0]]) {
      prompt = prompt.replace(new RegExp(`\\b${escaped(alias)}\\b`, "gi"), token);
    }
  });
  prompt = prompt
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED_PHONE]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_IDENTIFIER]")
    // Unknown capitalized words may be names not present in this scheduling
    // snapshot. Redacting them is conservative; the allowlisted tokens retain
    // the patient/service references the model is permitted to return.
    .replace(/\b[A-Z][a-z]{1,50}\b/g, "[REDACTED_NAME]");
  return { prompt, patients, services };
}

function parseModelRequest(value: unknown, entities: EntityMap): StructuredRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!INTENTS.includes(raw.intent as Intent)) return null;
  const patient = typeof raw.patient_token === "string" ? entities.patients.get(raw.patient_token) : undefined;
  const service = typeof raw.service_token === "string" ? entities.services.get(raw.service_token) : undefined;
  const protectedServices = Array.isArray(raw.protected_service_tokens)
    ? raw.protected_service_tokens.flatMap((token) => typeof token === "string" && entities.services.has(token) ? [entities.services.get(token)!.id] : [])
    : [];
  const target = typeof raw.target_hours === "number" && Number.isFinite(raw.target_hours) && raw.target_hours >= 0 && raw.target_hours <= 168 ? raw.target_hours : undefined;
  const count = typeof raw.count === "number" && Number.isSafeInteger(raw.count) && raw.count >= 1 && raw.count <= 20 ? raw.count : undefined;
  const providerType = typeof raw.provider_type === "string" && /^[A-Za-z]{2,30}$/.test(raw.provider_type) ? raw.provider_type.toUpperCase() : undefined;
  const intent = raw.intent as Intent;
  const unmatched: string[] = [];
  if (["OPTIMIZE_PATIENT", "FILL_SERVICE", "EXPLAIN_PATIENT"].includes(intent) && !patient) unmatched.push("a patient name");
  if (["OPTIMIZE_PATIENT", "FILL_SERVICE", "EXPLAIN_PATIENT"].includes(intent) && !service) unmatched.push("a service name");
  return {
    intent,
    patient_id: patient?.id,
    patient_name: patient?.name,
    service_id: service?.id,
    service_name: service?.name,
    target_hours: target,
    protected_services: protectedServices.length ? protectedServices : undefined,
    provider_type: providerType,
    count,
    unmatched,
    confidence: intent === "UNKNOWN" || unmatched.length ? "low" : "high",
  };
}

export interface InterpretationResult {
  request: StructuredRequest;
  parser: "DETERMINISTIC" | "LLM";
  fallbackReason: string | null;
}

export async function interpretWithOptionalLlm(input: string, ctx: ScheduleContext): Promise<InterpretationResult> {
  const deterministic = interpret(input, ctx);
  if (deterministic.confidence === "high") return { request: deterministic, parser: "DETERMINISTIC", fallbackReason: null };
  let config;
  try { config = readLlmAssistantConfig(); }
  catch { return { request: deterministic, parser: "DETERMINISTIC", fallbackReason: "CONFIGURATION_INVALID" }; }
  if (!config) return { request: deterministic, parser: "DETERMINISTIC", fallbackReason: null };
  const entities = deidentifyAssistantQuestion(input, ctx);
  const schema = {
    intent: INTENTS,
    patient_tokens: [...entities.patients.keys()],
    service_tokens: [...entities.services.keys()],
    fields: ["intent", "patient_token", "service_token", "target_hours", "protected_service_tokens", "provider_type", "count"],
  };
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      cache: "no-store",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: `Translate scheduling text to exactly one JSON object. Use only supplied tokens and fields. Never answer the question. Schema: ${JSON.stringify(schema)}` },
          { role: "user", content: entities.prompt },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const choices = payload?.choices;
    const first = Array.isArray(choices) ? choices[0] : null;
    const message = first && typeof first === "object" ? (first as Record<string, unknown>).message : null;
    const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
    if (typeof content !== "string" || content.length > 10_000) throw new Error("RESPONSE_INVALID");
    const parsed = parseModelRequest(JSON.parse(content), entities);
    if (!parsed || parsed.confidence !== "high") throw new Error("STRUCTURE_INVALID");
    return { request: parsed, parser: "LLM", fallbackReason: null };
  } catch (error) {
    const code = error instanceof Error && /^HTTP_\d{3}$/.test(error.message) ? error.message : "REQUEST_FAILED";
    logEvent("warn", "assistant.llm_fallback", { error_code: code });
    return { request: deterministic, parser: "DETERMINISTIC", fallbackReason: code };
  }
}
