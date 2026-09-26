/**
 * What the bell says, and who it says it to.
 *
 * The risk in a notification panel is not that it fails to render — it is
 * that it shows one person something about another, or repeats one fact
 * sixteen times until nobody reads it. Both are tested here.
 */

import { describe, expect, it } from "vitest";

import { SlotGrid } from "../domain/slots";
import { ScheduleContext } from "../rules/context";
import { buildClinicRows } from "../testing/clinic";
import { WEEK_START } from "../testing/scenario";
import { buildAlerts, groupAlerts, scopeAlerts } from "./alerts";

const TODAY = "2026-09-23"; // Wednesday of the fixture week

function clinic() {
  return new ScheduleContext(
    new SlotGrid(WEEK_START, 7, "America/New_York"),
    buildClinicRows(),
  );
}

describe("alerts", () => {
  it("reports the lapsed credential the fixture deliberately contains", () => {
    const alerts = buildAlerts(clinic(), TODAY);
    const lapsed = alerts.filter((a) => a.id.startsWith("credential-"));

    expect(lapsed.length).toBeGreaterThan(0);
    expect(lapsed.every((a) => a.severity === "critical")).toBe(true);
    // It must point at the clinician's record, where it can be dealt with.
    expect(lapsed[0].href).toContain("/providers/");
  });

  it("puts the most severe first", () => {
    const alerts = buildAlerts(clinic(), TODAY);
    const rank = { critical: 0, warning: 1, info: 2 } as const;

    for (let i = 1; i < alerts.length; i += 1) {
      expect(rank[alerts[i].severity]).toBeGreaterThanOrEqual(
        rank[alerts[i - 1].severity],
      );
    }
  });

  it("collapses one fact repeated across many patients", () => {
    const alerts = buildAlerts(clinic(), TODAY);
    const grouped = groupAlerts(alerts);

    const expiries = alerts.filter((a) => a.id.startsWith("auth-expiry-"));
    const groupedExpiries = grouped.filter((a) => a.id.startsWith("group-auth-expiry-"));

    // The fixture ends every ABA authorization on the same date.
    expect(expiries.length).toBeGreaterThanOrEqual(3);
    expect(groupedExpiries).toHaveLength(1);
    expect(groupedExpiries[0].title).toMatch(/^\d+ patients:/);
    // A group cannot claim to be about one person.
    expect(groupedExpiries[0].patientId).toBeUndefined();
  });

  it("leaves a pair alone rather than hiding two names to save a line", () => {
    const alerts = buildAlerts(clinic(), TODAY);
    const grouped = groupAlerts(alerts, 99);
    expect(grouped).toHaveLength(alerts.length);
  });

  it("shows a clinician only their own patients and themselves", () => {
    const ctx = clinic();
    const all = buildAlerts(ctx, TODAY);

    // Alice Moreau, the demo therapist.
    const providerId = "prv-rbt-alice";
    const own = ctx.appointmentsByProvider.get(providerId) ?? [];
    const caseload = new Set(own.map((a) => a.patient_id));

    const scoped = scopeAlerts(all, ctx, providerId, true);

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(all.length);

    for (const alert of scoped) {
      if (alert.providerId) expect(alert.providerId).toBe(providerId);
      else if (alert.patientId) expect(caseload.has(alert.patientId)).toBe(true);
      else throw new Error(`practice-wide alert leaked to a scoped role: ${alert.id}`);
    }
  });

  it("names the patient for a scoped role instead of collapsing them away", () => {
    const ctx = clinic();
    const scoped = groupAlerts(
      scopeAlerts(buildAlerts(ctx, TODAY), ctx, "prv-rbt-alice", true),
    );

    // Grouping runs after scoping, so a therapist who can see one of the
    // affected patients gets that patient by name.
    expect(scoped.some((a) => a.id.startsWith("group-"))).toBe(false);
  });

  it("carries nothing that cannot cross to a client component", () => {
    // Alerts are built on the server and handed to the bell, which is a client
    // component. A function on one of these throws at render — and neither
    // tsc nor eslint catches it.
    for (const alert of groupAlerts(buildAlerts(clinic(), TODAY))) {
      for (const [key, value] of Object.entries(alert)) {
        expect(typeof value, `${alert.id}.${key}`).not.toBe("function");
      }
      expect(() => JSON.stringify(alert)).not.toThrow();
    }
  });
});
