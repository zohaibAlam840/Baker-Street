import { describe, expect, it } from "vitest";

import { overlaps } from "../domain/slots";
import { ScheduleContext, type SnapshotRows } from "../rules/context";
import { evaluateBooking } from "../rules/engine";
import { ID, buildScenario, buildScenarioRows, rangeFor, slotFor } from "../testing/scenario";
import { suggestScheduleRecovery } from "./engine";

describe("schedule recovery suggestions", () => {
  it("never offers a slot before an explicit recovery cutoff", () => {
    const { ctx } = buildScenario();
    const cutoff = ctx.grid.instantOf(slotFor("wed", "12:00"));
    const result = suggestScheduleRecovery(
      ctx,
      {
        kind: "APPOINTMENT",
        appointment_id: ID.abaWed,
        excluded_provider_ids: [ID.rbtAlice],
      },
      { not_before: cutoff, max_options_per_appointment: 25 },
    );

    for (const option of result.appointments[0].options) {
      expect(new Date(option.start_time).getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    }
  });

  it("applies the future cutoff before the candidate limit", () => {
    const { ctx } = buildScenario();
    const cutoff = ctx.grid.instantOf(slotFor("wed", "12:00"));
    const result = suggestScheduleRecovery(
      ctx,
      {
        kind: "APPOINTMENT",
        appointment_id: ID.abaWed,
        excluded_provider_ids: [ID.rbtAlice],
      },
      {
        not_before: cutoff,
        max_candidates_per_appointment: 1,
        max_options_per_appointment: 1,
      },
    );

    expect(result.status).toBe("RECOVERED");
    expect(result.appointments[0].options).toHaveLength(1);
    expect(new Date(result.appointments[0].options[0].start_time).getTime())
      .toBeGreaterThanOrEqual(cutoff.getTime());
  });

  it("ranks a same-time qualified provider replacement first", () => {
    const { ctx } = buildScenario();
    const result = suggestScheduleRecovery(
      ctx,
      { kind: "APPOINTMENT", appointment_id: ID.abaWed },
      { max_options_per_appointment: 5 },
    );

    expect(result.status).toBe("RECOVERED");
    expect(result.affected_count).toBe(1);
    const recovery = result.appointments[0];
    const recommended = recovery.options[0];
    expect(recovery.recommended_option_id).toBe(recommended.id);
    expect(recommended).toMatchObject({
      provider_id: ID.rbtCara,
      same_time: true,
      provider_changed: true,
      start_slot: slotFor("wed", "13:00"),
      end_slot: slotFor("wed", "18:00"),
    });
    expect(recommended.explanations[0].code).toBe("SAME_TIME_PROVIDER_REPLACEMENT");
  });

  it("excludes the unavailable provider and returns a legal recommendation", () => {
    const { ctx } = buildScenario();
    const result = suggestScheduleRecovery(ctx, {
      kind: "PROVIDER_UNAVAILABILITY",
      provider_id: ID.rbtAlice,
      unavailable_range: rangeFor("wed", "12:00", "18:00"),
    });
    const recommended = result.appointments[0].options[0];
    const source = ctx.appointments.find((appointment) => appointment.id === ID.abaWed)!;
    const reduced = new ScheduleContext(ctx.grid, {
      ...ctx.rows,
      appointments: ctx.rows.appointments.filter((appointment) => appointment.id !== source.id),
      appointmentResources: ctx.rows.appointmentResources.filter(
        (link) => link.appointment_id !== source.id,
      ),
    });

    expect(result.status).toBe("RECOVERED");
    expect(recommended.provider_id).not.toBe(ID.rbtAlice);
    expect(
      evaluateBooking(
        {
          patient_id: source.patient_id,
          service_id: recommended.service_id,
          provider_id: recommended.provider_id,
          authorization_id: recommended.authorization_id,
          location_id: recommended.location_id,
          resource_ids: recommended.resource_ids,
          range: { startSlot: recommended.start_slot, endSlot: recommended.end_slot },
          telehealth: recommended.telehealth,
        },
        reduced,
      ).valid,
    ).toBe(true);
  });

  it("never moves a locked visit", () => {
    const { ctx } = buildScenario();
    const before = JSON.stringify(ctx.rows.appointments);
    const result = suggestScheduleRecovery(ctx, {
      kind: "PROVIDER_UNAVAILABILITY",
      provider_id: ID.bcbaEve,
      unavailable_range: rangeFor("sat", "13:00", "14:00"),
    });

    expect(result).toMatchObject({
      status: "BLOCKED",
      affected_count: 1,
      recovered_count: 0,
      locked_preserved_count: 1,
      unresolved_count: 1,
    });
    expect(result.appointments[0]).toMatchObject({
      appointment_id: ID.parentTrainingSat,
      disposition: "LOCKED_PRESERVED",
      recommended_option_id: null,
      options: [],
    });
    expect(JSON.stringify(ctx.rows.appointments)).toBe(before);
  });

  it("assigns and proves required resources on a replacement", () => {
    const rows = buildScenarioRows();
    const replacementProvider = "prv-ot-replacement";
    rows.providers.push({
      id: replacementProvider,
      external_id: null,
      first_name: "Replacement",
      last_name: "Clinician",
      provider_type: "OT",
      status: "ACTIVE",
      timezone: "America/New_York",
      home_location_id: ID.clinicNorth,
    });
    rows.providerServices.push({
      id: "ps-ot-replacement",
      provider_id: replacementProvider,
      service_id: ID.ot,
      eligible: true,
      effective_start: null,
      effective_end: null,
    });
    rows.providerAvailability.push({
      id: "prav-ot-replacement",
      provider_id: replacementProvider,
      day_of_week: 4,
      start_time: "13:00",
      end_time: "19:00",
      availability_type: "CLINICAL",
      location_id: ID.clinicNorth,
      effective_start: null,
      effective_end: null,
    });
    const base = buildScenario();
    const ctx = new ScheduleContext(base.grid, rows);
    const result = suggestScheduleRecovery(ctx, {
      kind: "PROVIDER_UNAVAILABILITY",
      provider_id: ID.otGil,
      unavailable_range: rangeFor("thu", "17:00", "18:00"),
    });
    const recommended = result.appointments[0].options[0];

    expect(recommended).toMatchObject({
      provider_id: replacementProvider,
      same_time: true,
      resource_ids: [ID.otGym],
    });
    expect(result.appointments[0]).toMatchObject({
      flexibility: "PROTECTED",
      disposition: "RECOVERED",
    });
    expect(recommended.id).toContain(":in-person:");
    expect(recommended.id).toContain(`:${ID.otGym}`);
  });

  it("reports a protected visit when no legal alternative exists", () => {
    const { ctx } = buildScenario();
    const result = suggestScheduleRecovery(ctx, {
      kind: "APPOINTMENT",
      appointment_id: ID.therapyTue,
      excluded_provider_ids: [ID.therapistFay],
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.appointments[0]).toMatchObject({
      appointment_id: ID.therapyTue,
      flexibility: "PROTECTED",
      disposition: "NO_ALTERNATIVE",
      options: [],
    });
    expect(result.appointments[0].explanations[0].code).toBe("NO_LEGAL_ALTERNATIVE");
  });

  it("does not expose direct patient identity or names in its result", () => {
    const { ctx } = buildScenario();
    const result = suggestScheduleRecovery(ctx, {
      kind: "APPOINTMENT",
      appointment_id: ID.abaWed,
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("patient_id");
    expect(serialized).not.toContain(ID.john);
    expect(serialized).not.toContain("John");
    expect(serialized).not.toContain("Reyes");
  });

  it("is deterministic when every source table is reversed", () => {
    const original = buildScenarioRows();
    const reversed = Object.fromEntries(
      Object.entries(buildScenarioRows()).map(([key, value]) => [key, [...value].reverse()]),
    ) as unknown as SnapshotRows;
    const { grid } = buildScenario();
    const request = {
      kind: "PROVIDER_UNAVAILABILITY" as const,
      provider_id: ID.rbtAlice,
      unavailable_range: rangeFor("wed", "12:00", "18:00"),
    };

    const first = suggestScheduleRecovery(new ScheduleContext(grid, original), request);
    const second = suggestScheduleRecovery(new ScheduleContext(grid, reversed), request);
    expect(second).toEqual(first);
  });

  it("returns no impact for invalid ranges and windows without affected visits", () => {
    const { ctx } = buildScenario();
    const invalid = suggestScheduleRecovery(ctx, {
      kind: "PROVIDER_UNAVAILABILITY",
      provider_id: ID.rbtAlice,
      unavailable_range: { startSlot: 20, endSlot: 10 },
    });
    const empty = suggestScheduleRecovery(ctx, {
      kind: "PROVIDER_UNAVAILABILITY",
      provider_id: ID.rbtAlice,
      unavailable_range: rangeFor("sun", "09:00", "10:00"),
    });

    expect(invalid.status).toBe("NO_IMPACT");
    expect(invalid.explanations[0].code).toBe("INVALID_UNAVAILABILITY_RANGE");
    expect(empty.status).toBe("NO_IMPACT");
    expect(empty.explanations[0].code).toBe("NO_APPOINTMENTS_AFFECTED");
  });

  it("applies the candidate bound after excluding an unavailable provider", () => {
    const { ctx } = buildScenario();
    const result = suggestScheduleRecovery(
      ctx,
      {
        kind: "PROVIDER_UNAVAILABILITY",
        provider_id: ID.rbtAlice,
        unavailable_range: rangeFor("wed", "12:00", "18:00"),
      },
      {
        max_candidates_per_appointment: 1,
      },
    );

    expect(result.status).toBe("RECOVERED");
    expect(result.appointments[0].options).toHaveLength(1);
    expect(result.appointments[0].options[0].provider_id).toBe(ID.rbtCara);
    expect(result.appointments[0].options[0].provider_id).not.toBe(ID.rbtAlice);
  });

  it("uses authorization, modality, and resources in canonical option identity", () => {
    const rows = buildScenarioRows();
    const secondAuthorization = "auth-aba-secondary";
    rows.authorizations.push({
      ...rows.authorizations[0],
      id: secondAuthorization,
      authorization_number: "SECONDARY",
    });
    const { grid } = buildScenario();
    const ctx = new ScheduleContext(grid, rows);
    const result = suggestScheduleRecovery(
      ctx,
      {
        kind: "PROVIDER_UNAVAILABILITY",
        provider_id: ID.rbtAlice,
        unavailable_range: rangeFor("wed", "12:00", "18:00"),
      },
      { max_options_per_appointment: 25 },
    );
    const sameBooking = result.appointments[0].options.filter(
      (option) =>
        option.provider_id === ID.rbtCara &&
        option.start_slot === slotFor("wed", "13:00") &&
        option.end_slot === slotFor("wed", "18:00"),
    );

    expect(new Set(sameBooking.map((option) => option.authorization_id))).toEqual(
      new Set([ID.abaAuth, secondAuthorization]),
    );
    expect(new Set(sameBooking.map((option) => option.id)).size).toBe(sameBooking.length);
    for (const option of sameBooking) {
      expect(option.id).toContain(`:${option.authorization_id}:`);
      expect(option.id).toContain(":in-person:");
    }
  });

  it("preserves telehealth modality and includes it in option identity", () => {
    const rows = buildScenarioRows();
    const replacementProvider = "prv-bcba-remote";
    const source = rows.appointments.find(
      (appointment) => appointment.id === ID.parentTrainingSat,
    )!;
    source.scheduling_flexibility = "FLEXIBLE";
    source.telehealth = true;
    source.location_id = ID.telehealth;
    rows.providers.push({
      id: replacementProvider,
      external_id: null,
      first_name: "Remote",
      last_name: "Replacement",
      provider_type: "BCBA",
      status: "ACTIVE",
      timezone: "America/New_York",
      home_location_id: ID.clinicNorth,
    });
    rows.providerServices.push({
      id: "ps-bcba-remote-parent",
      provider_id: replacementProvider,
      service_id: ID.parentTraining,
      eligible: true,
      effective_start: null,
      effective_end: null,
    });
    rows.providerAvailability.push({
      id: "prav-bcba-remote-sat",
      provider_id: replacementProvider,
      day_of_week: 6,
      start_time: "09:00",
      end_time: "16:00",
      availability_type: "CLINICAL",
      location_id: ID.clinicNorth,
      effective_start: null,
      effective_end: null,
    });
    const { grid } = buildScenario();
    const result = suggestScheduleRecovery(
      new ScheduleContext(grid, rows),
      {
        kind: "PROVIDER_UNAVAILABILITY",
        provider_id: ID.bcbaEve,
        unavailable_range: rangeFor("sat", "13:00", "14:00"),
      },
      { max_options_per_appointment: 2 },
    );
    const recommended = result.appointments[0].options[0];

    expect(recommended).toMatchObject({
      provider_id: replacementProvider,
      telehealth: true,
      resource_ids: [],
      same_time: true,
    });
    expect(recommended.id).toContain(":telehealth:");
  });

  it("returns recommendations that do not collide across a provider callout", () => {
    const { ctx } = buildScenario();
    const result = suggestScheduleRecovery(
      ctx,
      {
        kind: "PROVIDER_UNAVAILABILITY",
        provider_id: ID.rbtAlice,
        unavailable_range: {
          startSlot: slotFor("wed", "12:00"),
          endSlot: slotFor("fri", "18:00"),
        },
      },
      { max_options_per_appointment: 2, max_candidates_per_appointment: 4_000 },
    );
    const recommendations = result.appointments
      .map((item) => item.options[0])
      .filter((option) => option != null);

    for (let left = 0; left < recommendations.length; left += 1) {
      for (let right = left + 1; right < recommendations.length; right += 1) {
        expect(
          overlaps(
            {
              startSlot: recommendations[left].start_slot,
              endSlot: recommendations[left].end_slot,
            },
            {
              startSlot: recommendations[right].start_slot,
              endSlot: recommendations[right].end_slot,
            },
          ),
        ).toBe(false);
      }
    }
  });
});
