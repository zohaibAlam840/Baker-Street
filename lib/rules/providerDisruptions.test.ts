import { describe, expect, it } from "vitest";

import { ScheduleContext } from "./context";
import { ID, buildScenario, buildScenarioRows, rangeFor } from "../testing/scenario";

describe("dated provider disruptions", () => {
  it("subtracts an open callout from recurring clinical availability", () => {
    const { grid, ctx } = buildScenario();
    const callout = rangeFor("wed", "13:00", "14:00");
    const rows = buildScenarioRows();
    rows.providerDisruptions = [{
      id: "callout-open",
      provider_id: ID.rbtAlice,
      starts_at: grid.instantOf(callout.startSlot).toISOString(),
      ends_at: grid.instantOf(callout.endSlot).toISOString(),
      status: "OPEN",
    }];
    const disrupted = new ScheduleContext(grid, rows);

    expect(ctx.providerClinicalWindows(ID.rbtAlice).some((window) =>
      window.startSlot <= callout.startSlot && window.endSlot >= callout.endSlot,
    )).toBe(true);
    expect(disrupted.providerClinicalWindows(ID.rbtAlice).some((window) =>
      window.startSlot <= callout.startSlot && window.endSlot >= callout.endSlot,
    )).toBe(false);
  });

  it("stops blocking provider availability after a callout is withdrawn", () => {
    const { grid } = buildScenario();
    const callout = rangeFor("wed", "13:00", "14:00");
    const rows = buildScenarioRows();
    rows.providerDisruptions = [{
      id: "callout-resolved",
      provider_id: ID.rbtAlice,
      starts_at: grid.instantOf(callout.startSlot).toISOString(),
      ends_at: grid.instantOf(callout.endSlot).toISOString(),
      status: "WITHDRAWN",
    }];
    const context = new ScheduleContext(grid, rows);

    expect(context.providerClinicalWindows(ID.rbtAlice).some((window) =>
      window.startSlot <= callout.startSlot && window.endSlot >= callout.endSlot,
    )).toBe(true);
  });

  it("continues blocking the outage window after its recovery cases resolve", () => {
    const { grid } = buildScenario();
    const callout = rangeFor("wed", "13:00", "14:00");
    const rows = buildScenarioRows();
    rows.providerDisruptions = [{
      id: "callout-work-resolved",
      provider_id: ID.rbtAlice,
      starts_at: grid.instantOf(callout.startSlot).toISOString(),
      ends_at: grid.instantOf(callout.endSlot).toISOString(),
      status: "RESOLVED",
    }];
    const context = new ScheduleContext(grid, rows);

    expect(context.providerClinicalWindows(ID.rbtAlice).some((window) =>
      window.startSlot <= callout.startSlot && window.endSlot >= callout.endSlot,
    )).toBe(false);
  });
});
