import { describe, expect, it } from "vitest";
import { readLlmAssistantConfig } from "./llmConfig";

describe("LLM assistant configuration", () => {
  it("is disabled by default", () => expect(readLlmAssistantConfig({})).toBeNull());
  it("requires explicit PHI approval", () => expect(() => readLlmAssistantConfig({ LLM_ASSISTANT_ENABLED: "true" })).toThrow(/PHI_APPROVED/));
  it("accepts an approved authenticated HTTPS endpoint", () => {
    expect(readLlmAssistantConfig({
      LLM_ASSISTANT_ENABLED: "true",
      LLM_ASSISTANT_PHI_APPROVED: "true",
      LLM_ASSISTANT_BASE_URL: "https://model.example.org/v1",
      LLM_ASSISTANT_API_KEY: "a-key-with-at-least-20-characters",
      LLM_ASSISTANT_MODEL: "approved-model-v1",
    })?.endpoint).toBe("https://model.example.org/v1/chat/completions");
  });
});
