/**
 * The language layer, under test.
 *
 * Two things matter here and neither is "does it parse nicely". First, every
 * phrasing the product puts on screen as a suggestion has to work — a chip a
 * user taps that then fails is worse than no chip. Second, the parser must
 * stay inside the boundary spec sections 58-59 draw: it decides *which*
 * question was asked and nothing else, so what it returns is a request, never
 * an answer.
 */

import { describe, expect, it } from "vitest";

import { SlotGrid } from "../domain/slots";
import { ScheduleContext } from "../rules/context";
import { buildClinicRows } from "../testing/clinic";
import { ID, WEEK_START, buildScenario } from "../testing/scenario";
import { EXAMPLE_REQUESTS, interpret } from "./interpret";
import { answerQuestion } from "./answer";

describe("interpret", () => {
  /** What the app itself loads: the whole demo clinic. */
  const clinic = () =>
    new ScheduleContext(
      new SlotGrid(WEEK_START, 7, "America/New_York"),
      buildClinicRows(),
    );

  it("resolves every request the UI offers as a suggestion", () => {
    const ctx = clinic();

    for (const example of EXAMPLE_REQUESTS) {
      const request = interpret(example, ctx);
      expect(request.intent, example).not.toBe("UNKNOWN");

      // And it has to survive the whole way to a rendered answer.
      const answer = answerQuestion(ctx, request);
      expect(answer.kind, example).not.toBe("unresolved");
      expect(answer.summary.length, example).toBeGreaterThan(20);
    }
    // Five full engine analyses over the whole clinic — slower than the
    // default timeout allows, and it is the engine work that makes the test
    // worth having.
  }, 30_000);

  it("reads the patient, service and target out of the acceptance question", () => {
    const { ctx } = buildScenario();
    const request = interpret(
      "Get John to 30 hours of ABA this week without moving his OT or therapy",
      ctx,
    );

    expect(request.patient_id).toBe(ID.john);
    expect(request.service_id).toBe(ID.aba);
    expect(request.target_hours).toBe(30);
    expect(request.protected_services ?? []).not.toHaveLength(0);
    expect(request.confidence).toBe("high");
  });

  it("assumes the patient's largest service when none is named, and says so", () => {
    const { ctx } = buildScenario();
    const request = interpret("Why can't John reach 40 hours?", ctx);

    expect(request.patient_id).toBe(ID.john);
    expect(request.assumed_service).toBe(true);
    expect(request.service_id).toBe(ID.aba);

    // The assumption has to reach the reader — answering about a service
    // nobody named, silently, is the failure this guards against.
    const answer = answerQuestion(ctx, request);
    expect(answer.notes.join(" ")).toMatch(/did not name a service/i);
  });

  it("reports an unreachable target as unreachable", () => {
    const { ctx } = buildScenario();
    const answer = answerQuestion(ctx, interpret("Why can't John reach 40 hours?", ctx));

    expect(answer.summary).toMatch(/cannot reach 40 hours/i);
    // And the engine's reasons come with it, most-binding first.
    expect(answer.blockers.length).toBeGreaterThan(0);
  });

  it("does not invent an intent for a sentence that has none", () => {
    const { ctx } = buildScenario();
    const request = interpret("make me a sandwich", ctx);

    expect(request.intent).toBe("UNKNOWN");
    expect(request.confidence).toBe("low");
    expect(answerQuestion(ctx, request).kind).toBe("unresolved");
  });

  it("never returns hours, providers or slots — only a request", () => {
    const { ctx } = buildScenario();
    const request = interpret("Get John to 30 hours of ABA", ctx);

    // The shape is the contract: no availability, no schedule, no decision.
    expect(Object.keys(request).sort()).toEqual(
      [
        "assumed_service",
        "confidence",
        "count",
        "intent",
        "patient_id",
        "patient_name",
        "protected_services",
        "provider_type",
        "service_id",
        "service_name",
        "target_hours",
        "unmatched",
      ].sort(),
    );
  });
});
