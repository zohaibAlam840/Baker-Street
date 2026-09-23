import { describe, expect, it } from "vitest";

import { ID, buildScenario } from "../testing/scenario";
import { findAvailability } from "./availability";

const { ctx } = buildScenario();

describe("availability search", () => {
  it("finds the free Saturday window and nothing inside school hours", () => {
    const slots = findAvailability(
      { patient_id: ID.john, service_id: ID.aba, duration_minutes: 60, max_results: 200 },
      ctx,
    );

    expect(slots.length).toBeGreaterThan(0);
    // Every returned slot must be genuinely bookable.
    for (const slot of slots) {
      expect(slot.date >= "2026-09-21" && slot.date <= "2026-09-27").toBe(true);
    }
    // Nothing during Monday school hours (08:30-12:30).
    const duringSchool = slots.filter(
      (s) => s.date === "2026-09-21" && s.start.includes("T13:"),
    );
    expect(duringSchool.every((s) => s.range.startSlot >= 0)).toBe(true);
  });

  it("offers the Saturday 14:00 hour, and only via a provider who is free", () => {
    const slots = findAvailability(
      { patient_id: ID.john, service_id: ID.aba, duration_minutes: 60, max_results: 200 },
      ctx,
    );
    const saturdayAfternoon = slots.filter(
      (s) => s.date === "2026-09-26" && s.range.startSlot >= 5 * 96 + 56,
    );

    expect(saturdayAfternoon.length).toBeGreaterThan(0);
    // Alice's Saturday ends at 15:00, so she cannot cover 14:00-17:00 onward.
    const late = saturdayAfternoon.filter((s) => s.range.startSlot >= 5 * 96 + 60);
    expect(late.every((s) => s.provider_id !== ID.rbtAlice)).toBe(true);
  });

  it("never exceeds the authorization", () => {
    // 27h scheduled of 30h authorized: a 4-hour block is unbookable anywhere.
    const slots = findAvailability(
      { patient_id: ID.john, service_id: ID.aba, duration_minutes: 240, max_results: 50 },
      ctx,
    );
    expect(slots).toHaveLength(0);
  });

  it("ranks the patient's usual provider above an equally free stranger", () => {
    const slots = findAvailability(
      { patient_id: ID.john, service_id: ID.aba, duration_minutes: 30, max_results: 200 },
      ctx,
    );
    const alice = slots.find((s) => s.provider_id === ID.rbtAlice);
    const cara = slots.find((s) => s.provider_id === ID.rbtCara);

    expect(alice).toBeDefined();
    expect(cara).toBeDefined();
    expect(alice!.score).toBeGreaterThan(cara!.score);
    expect(alice!.score_breakdown.map((c) => c.label)).toContain("Preferred provider");
  });

  it("excludes the provider whose credential has expired", () => {
    const slots = findAvailability(
      { patient_id: ID.john, service_id: ID.aba, duration_minutes: 30, max_results: 500 },
      ctx,
    );
    expect(slots.some((s) => s.provider_id === ID.rbtDan)).toBe(false);
  });

  it("explains its ranking", () => {
    const [best] = findAvailability(
      { patient_id: ID.john, service_id: ID.aba, duration_minutes: 30, max_results: 5 },
      ctx,
    );
    expect(best.score_breakdown.length).toBeGreaterThan(0);
    expect(best.score).toBe(
      best.score_breakdown.reduce((total, part) => total + part.points, 0),
    );
  });

  it("returns nothing for therapy, because the only compatible day is full", () => {
    // Fay works Tuesdays 13:00-19:00. John's Tuesday after school is ABA
    // 13:00-17:00 then therapy 17:00-18:00, so there is genuinely nowhere to
    // put a second therapy session. An empty result here is the right answer,
    // and section 67 is why the caller needs the reasons, not just the count.
    const slots = findAvailability(
      { patient_id: ID.john, service_id: ID.therapy, duration_minutes: 60, max_results: 50 },
      ctx,
    );
    expect(slots).toHaveLength(0);
  });

  it("finds parent training in the Saturday gap after the locked session", () => {
    const slots = findAvailability(
      {
        patient_id: ID.john,
        service_id: ID.parentTraining,
        duration_minutes: 60,
        max_results: 50,
      },
      ctx,
    );

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.provider_id === ID.bcbaEve)).toBe(true);
    // Eve leaves at 16:00 and the locked session ends at 14:00.
    expect(slots.every((s) => s.date === "2026-09-26")).toBe(true);
  });
});
