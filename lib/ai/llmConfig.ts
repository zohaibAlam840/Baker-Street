export interface LlmAssistantConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;
const value = (env: Environment, name: string) => env[name]?.trim() ?? "";

export class LlmConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "LlmConfigurationError"; }
}

export function readLlmAssistantConfig(env: Environment = process.env): LlmAssistantConfig | null {
  const enabled = value(env, "LLM_ASSISTANT_ENABLED").toLowerCase() || "false";
  if (enabled !== "true" && enabled !== "false") throw new LlmConfigurationError("LLM_ASSISTANT_ENABLED must be true or false.");
  if (enabled === "false") return null;
  if (value(env, "LLM_ASSISTANT_PHI_APPROVED").toLowerCase() !== "true") {
    throw new LlmConfigurationError("LLM_ASSISTANT_PHI_APPROVED must be true before the external language model is enabled.");
  }
  let base: URL;
  try { base = new URL(value(env, "LLM_ASSISTANT_BASE_URL")); } catch { throw new LlmConfigurationError("LLM_ASSISTANT_BASE_URL must be a valid HTTPS URL."); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new LlmConfigurationError("LLM_ASSISTANT_BASE_URL must be an HTTPS URL without credentials, query, or fragment.");
  }
  const apiKey = value(env, "LLM_ASSISTANT_API_KEY");
  if (apiKey.length < 20) throw new LlmConfigurationError("LLM_ASSISTANT_API_KEY must contain at least 20 characters.");
  const model = value(env, "LLM_ASSISTANT_MODEL");
  if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) throw new LlmConfigurationError("LLM_ASSISTANT_MODEL has an invalid format.");
  const timeoutMs = Number(value(env, "LLM_ASSISTANT_TIMEOUT_MS") || 6_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20_000) {
    throw new LlmConfigurationError("LLM_ASSISTANT_TIMEOUT_MS must be an integer between 500 and 20000.");
  }
  return { endpoint: `${base.toString().replace(/\/$/, "")}/chat/completions`, apiKey, model, timeoutMs };
}
