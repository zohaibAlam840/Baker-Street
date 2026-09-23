import { describe, expect, it } from "vitest";

import { SlotGrid } from "./slots";
import { formatDateOnly, startOfWeek, zonedParts, zonedTimeToInstant } from "./time";

const TZ = "America/New_York";

describe("startOfWeek", () => {
  /**
   * Regression guard. Anchoring a horizon on the requested day rather than the
   * containing week made weekly authorization totals under-count: a Saturday
   * request excluded Monday to Friday and reported hours that were already
   * spent as still available.
   */
  it("returns the Monday of the containing week for every day", () => {
    const week = {
      "2026-09-21": "Monday",
      "2026-09-22": "Tuesday",
      "2026-09-23": "Wednesday",
      "2026-09-24": "Thursday",
      "2026-09-25": "Friday",
      "2026-09-26": "Saturday",
      "2026-09-27": "Sunday",
    };
    for (const date of Object.keys(week)) {
      const [y, m, d] = date.split("-").map(Number);
      expect(startOfWeek(zonedTimeToInstant(TZ, y, m, d, 12), TZ)).toBe("2026-09-21");
    }
  });

  it("does not roll back past a month boundary incorrectly", () => {
    // 2026-10-01 is a Thursday; its week starts Monday 2026-09-28.
    expect(startOfWeek(zonedTimeToInstant(TZ, 2026, 10, 1, 9), TZ)).toBe("2026-09-28");
  });
});

describe("zoned wall-clock conversion", () => {
  it("round-trips a local time through an instant", () => {
    const instant = zonedTimeToInstant(TZ, 2026, 9, 26, 14, 30);
    const parts = zonedParts(instant, TZ);
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([
      2026, 9, 26, 14, 30,
    ]);
  });

  it("round-trips across the autumn DST change", () => {
    // US DST ends 2026-11-01. 01:30 occurs twice; the earlier one is chosen.
    const instant = zonedTimeToInstant(TZ, 2026, 11, 1, 13, 0);
    const parts = zonedParts(instant, TZ);
    expect([parts.month, parts.day, parts.hour]).toEqual([11, 1, 13]);
  });

  it("round-trips across the spring DST change", () => {
    // US DST starts 2026-03-08; 02:00-03:00 does not exist locally.
    const instant = zonedTimeToInstant(TZ, 2026, 3, 8, 13, 0);
    expect(zonedParts(instant, TZ).hour).toBe(13);
  });
});

describe("SlotGrid across a DST boundary", () => {
  /**
   * The week of 2026-11-01 is 25 hours long in wall-clock terms. Slot indices
   * are anchored to local midnight each day, so a 13:00 appointment must sit
   * at the same slot-of-day on both sides of the change — otherwise every
   * recurring availability rule shifts by an hour for half the week.
   */
  const grid = SlotGrid.week("2026-10-26", TZ); // Mon 26 Oct - Sun 1 Nov

  it("keeps a wall-clock time on the same slot-of-day before and after", () => {
    const before = grid.slotOf(zonedTimeToInstant(TZ, 2026, 10, 28, 13, 0));
    const after = grid.slotOf(zonedTimeToInstant(TZ, 2026, 11, 1, 13, 0));

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before! % 96).toBe(after! % 96);
    expect(before! % 96).toBe(52); // 13:00 = 13 * 4
  });

  it("places every day of the horizon on its own date", () => {
    const dates = Array.from({ length: 7 }, (_, i) =>
      formatDateOnly(grid.dayStart(i), TZ),
    );
    expect(dates).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });
});
