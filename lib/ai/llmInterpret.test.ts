import { afterEach, describe, expect, it, vi } from "vitest";

import { ID, buildScenario } from "../testing/scenario";
import { deidentifyAssistantQuestion, interpretWithOptionalLlm } from "./llmInterpret";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function enable() {
  vi.stubEnv("LLM_ASSISTANT_ENABLED", "true");
  vi.stubEnv("LLM_ASSISTANT_PHI_APPROVED", "true");
  vi.stubEnv("LLM_ASSISTANT_BASE_URL", "https://model.example.org/v1");
  vi.stubEnv("LLM_ASSISTANT_API_KEY", "a-key-with-at-least-20-characters");
  vi.stubEnv("LLM_ASSISTANT_MODEL", "approved-model-v1");
}

describe("optional LLM interpretation", () => {
  it("replaces known patient/service names and contact patterns before transmission", () => {
    const { ctx } = buildScenario();
    const result = deidentifyAssistantQuestion("Could you top up John Doe's ABA? email john@example.org", ctx);
    expect(result.prompt).not.toMatch(/John|Doe|john@example\.org|ABA/i);
    expect(result.prompt).toContain("PATIENT_");
    expect(result.prompt).toContain("SERVICE_");
  });

  it("maps only allowlisted tokens back to engine IDs", async () => {
    enable();
    const { ctx } = buildScenario();
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "FILL_SERVICE", patient_token: "PATIENT_1", service_token: "SERVICE_1", target_hours: 30 }) } }] }), { status: 200 });
    }));
    const result = await interpretWithOptionalLlm("Could we top up the first patient's care?", ctx);
    expect(result.parser).toBe("LLM");
    expect(result.request.patient_id).toBe([...ctx.patients.values()][0].id);
    expect(result.request.service_id).toBe([...ctx.services.values()][0].id);
    expect(sent).not.toContain(ID.john);
  });

  it("uses deterministic output when the provider fails", async () => {
    enable();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const { ctx } = buildScenario();
    const result = await interpretWithOptionalLlm("A phrasing the fixed parser does not know", ctx);
    expect(result.parser).toBe("DETERMINISTIC");
    expect(result.fallbackReason).toBe("REQUEST_FAILED");
  });
});
