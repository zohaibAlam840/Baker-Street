/**
 * The 15-minute slot grid (spec section 28).
 *
 *   00:00 = slot 0   00:15 = slot 1   00:30 = slot 2   00:45 = slot 3
 *   1 hour = 4 slots
 *
 * Every constraint in the engine is integer arithmetic over this grid. Nothing
 * downstream should do date maths directly: a slot index plus a `SlotGrid` is
 * the only currency the rule engine and the future solver speak.
 */

import { Weekday, addDays, parseDateOnly, zonedParts, zonedTimeToInstant } from "./time";

export const SLOT_MINUTES = 15;
export const SLOTS_PER_HOUR = 60 / SLOT_MINUTES; // 4
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES; // 96

export function minutesToSlots(minutes: number): number {
  return Math.round(minutes / SLOT_MINUTES);
}

export function slotsToMinutes(slots: number): number {
  return slots * SLOT_MINUTES;
}

export function hoursToSlots(hours: number): number {
  return Math.round(hours * SLOTS_PER_HOUR);
}

export function slotsToHours(slots: number): number {
  return slots / SLOTS_PER_HOUR;
}

/** A half-open slot range `[startSlot, endSlot)`. */
export interface SlotRange {
  startSlot: number;
  endSlot: number;
}

export function rangeDuration(range: SlotRange): number {
  return range.endSlot - range.startSlot;
}

/** Half-open overlap: touching ranges (10:00-11:00, 11:00-12:00) do not clash. */
export function overlaps(a: SlotRange, b: SlotRange): boolean {
  return a.startSlot < b.endSlot && b.startSlot < a.endSlot;
}

/** `null` when the two ranges do not meet. */
export function intersect(a: SlotRange, b: SlotRange): SlotRange | null {
  const startSlot = Math.max(a.startSlot, b.startSlot);
  const endSlot = Math.min(a.endSlot, b.endSlot);
  return startSlot < endSlot ? { startSlot, endSlot } : null;
}

/** Intersect every range in `a` with every range in `b`, merged and sorted. */
export function intersectAll(a: SlotRange[], b: SlotRange[]): SlotRange[] {
  const out: SlotRange[] = [];
  for (const left of a) {
    for (const right of b) {
      const hit = intersect(left, right);
      if (hit) out.push(hit);
    }
  }
  return mergeRanges(out);
}

/** Remove every part of `ranges` covered by `cuts`. */
export function subtractRanges(ranges: SlotRange[], cuts: SlotRange[]): SlotRange[] {
  let current = mergeRanges(ranges);
  for (const cut of mergeRanges(cuts)) {
    const next: SlotRange[] = [];
    for (const range of current) {
      if (!overlaps(range, cut)) {
        next.push(range);
        continue;
      }
      if (range.startSlot < cut.startSlot) {
        next.push({ startSlot: range.startSlot, endSlot: cut.startSlot });
      }
      if (cut.endSlot < range.endSlot) {
        next.push({ startSlot: cut.endSlot, endSlot: range.endSlot });
      }
    }
    current = next;
  }
  return current;
}

/** Sort and coalesce touching or overlapping ranges. */
export function mergeRanges(ranges: SlotRange[]): SlotRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startSlot - b.startSlot);
  const out: SlotRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (range.startSlot <= last.endSlot) {
      last.endSlot = Math.max(last.endSlot, range.endSlot);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/**
 * Maps absolute instants onto slot indices for one scheduling horizon.
 *
 * Slot 0 is local midnight on `startDate` in `timeZone`. Because the anchor is
 * resolved through the zone, a horizon spanning a DST change still lines up
 * with local wall clock on every day.
 */
export class SlotGrid {
  readonly timeZone: string;
  readonly startDate: string; // YYYY-MM-DD, local
  readonly dayCount: number;
  /** Absolute instant of local midnight on each day of the horizon. */
  private readonly dayAnchors: Date[];
  private readonly dayWeekdays: Weekday[];
  private readonly instantCache = new Map<number, Date>();
  private readonly wallClockRangeCache = new Map<string, boolean>();

  constructor(startDate: string, dayCount: number, timeZone: string) {
    this.startDate = startDate;
    this.dayCount = dayCount;
    this.timeZone = timeZone;

    const { year, month, day } = parseDateOnly(startDate);
    this.dayAnchors = [];
    for (let offset = 0; offset < dayCount; offset += 1) {
      // Date.UTC normalises month/day rollover for us.
      const rolled = new Date(Date.UTC(year, month - 1, day + offset));
      this.dayAnchors.push(
        zonedTimeToInstant(
          timeZone,
          rolled.getUTCFullYear(),
          rolled.getUTCMonth() + 1,
          rolled.getUTCDate(),
        ),
      );
    }
    this.dayWeekdays = this.dayAnchors.map(
      (anchor) => zonedParts(anchor, this.timeZone).weekday,
    );
  }

  static week(startDate: string, timeZone: string): SlotGrid {
    return new SlotGrid(startDate, 7, timeZone);
  }

  get totalSlots(): number {
    return this.dayCount * SLOTS_PER_DAY;
  }

  /** Local midnight of horizon day `dayIndex`, as an absolute instant. */
  dayStart(dayIndex: number): Date {
    return this.dayAnchors[dayIndex];
  }

  /** The weekday (0 = Sunday) of horizon day `dayIndex`. */
  weekdayOf(dayIndex: number): Weekday {
    return this.dayWeekdays[dayIndex];
  }

  /** Horizon day indices matching a recurring weekday rule. */
  daysMatching(weekday: Weekday): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.dayCount; i += 1) {
      if (this.weekdayOf(i) === weekday) out.push(i);
    }
    return out;
  }

  /** Slot index for `dayIndex` at `minutesPastMidnight` local. */
  slotAt(dayIndex: number, minutesPastMidnight: number): number {
    return dayIndex * SLOTS_PER_DAY + minutesToSlots(minutesPastMidnight);
  }

  /**
   * Slot index containing `instant`, or null when it falls outside the
   * horizon. Instants that are not on the grid are floored.
   */
  slotOf(instant: Date): number | null {
    const dayIndex = this.dayIndexOf(instant);
    if (dayIndex === null) return null;
    const p = zonedParts(instant, this.timeZone);
    return this.slotAt(dayIndex, p.hour * 60 + p.minute);
  }

  /**
   * Slot boundary at or after `instant` — the right edge for an appointment's
   * end, so that a 10:00-11:00 booking occupies slots [40, 44).
   */
  slotCeilOf(instant: Date): number | null {
    const dayIndex = this.dayIndexOf(instant);
    if (dayIndex === null) {
      // An end time landing exactly on the horizon's closing midnight is the
      // last valid boundary rather than an out-of-range instant.
      if (instant.getTime() === this.horizonEnd().getTime()) return this.totalSlots;
      return null;
    }
    const p = zonedParts(instant, this.timeZone);
    return dayIndex * SLOTS_PER_DAY + Math.ceil((p.hour * 60 + p.minute) / SLOT_MINUTES);
  }

  /** Convert an appointment's instants into a slot range, clipped to the horizon. */
  rangeOf(start: Date, end: Date): SlotRange | null {
    const startSlot = this.slotOf(start) ?? (start < this.dayAnchors[0] ? 0 : null);
    const endSlot = this.slotCeilOf(end) ?? (end > this.horizonEnd() ? this.totalSlots : null);
    if (startSlot === null || endSlot === null) return null;
    const clippedStart = Math.max(0, startSlot);
    const clippedEnd = Math.min(this.totalSlots, endSlot);
    return clippedStart < clippedEnd
      ? { startSlot: clippedStart, endSlot: clippedEnd }
      : null;
  }

  /** The absolute instant a slot boundary sits at. */
  instantOf(slot: number): Date {
    const cached = this.instantCache.get(slot);
    if (cached) return cached;
    const dayIndex = Math.floor(slot / SLOTS_PER_DAY);
    const withinDay = slot % SLOTS_PER_DAY;
    const localDate = addDays(this.startDate, dayIndex);
    const { year, month, day } = parseDateOnly(localDate);
    const minutes = slotsToMinutes(withinDay);
    const instant = zonedTimeToInstant(
      this.timeZone,
      year,
      month,
      day,
      Math.floor(minutes / 60),
      minutes % 60,
    );
    this.instantCache.set(slot, instant);
    return instant;
  }

  /**
   * Whether both wall-clock boundaries exist and their elapsed duration still
   * equals the requested slot duration. This rejects spring-forward gaps and
   * ambiguous fall-back ranges before they can shift on conversion to UTC.
   */
  isValidWallClockRange(range: SlotRange): boolean {
    const cacheKey = `${range.startSlot}:${range.endSlot}`;
    const cached = this.wallClockRangeCache.get(cacheKey);
    if (cached != null) return cached;
    if (
      range.startSlot < 0 ||
      range.endSlot > this.totalSlots ||
      range.startSlot >= range.endSlot
    ) {
      this.wallClockRangeCache.set(cacheKey, false);
      return false;
    }
    const boundaryMatches = (slot: number) => {
      const dayIndex = Math.floor(slot / SLOTS_PER_DAY);
      const withinDay = slot % SLOTS_PER_DAY;
      const expectedDate = addDays(this.startDate, dayIndex);
      const expectedMinutes = slotsToMinutes(withinDay);
      const parts = zonedParts(this.instantOf(slot), this.timeZone);
      const actualDate = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
      return (
        actualDate === expectedDate &&
        parts.hour * 60 + parts.minute === expectedMinutes
      );
    };
    if (!boundaryMatches(range.startSlot) || !boundaryMatches(range.endSlot)) {
      this.wallClockRangeCache.set(cacheKey, false);
      return false;
    }
    const elapsedMinutes =
      (this.instantOf(range.endSlot).getTime() - this.instantOf(range.startSlot).getTime()) /
      60_000;
    const valid = elapsedMinutes === slotsToMinutes(range.endSlot - range.startSlot);
    this.wallClockRangeCache.set(cacheKey, valid);
    return valid;
  }

  /** Exclusive end of the horizon, as an absolute instant. */
  horizonEnd(): Date {
    const { year, month, day } = parseDateOnly(this.startDate);
    const rolled = new Date(Date.UTC(year, month - 1, day + this.dayCount));
    return zonedTimeToInstant(
      this.timeZone,
      rolled.getUTCFullYear(),
      rolled.getUTCMonth() + 1,
      rolled.getUTCDate(),
    );
  }

  private dayIndexOf(instant: Date): number | null {
    for (let i = 0; i < this.dayCount; i += 1) {
      const start = this.dayAnchors[i];
      const end = i + 1 < this.dayCount ? this.dayAnchors[i + 1] : this.horizonEnd();
      if (instant >= start && instant < end) return i;
    }
    return null;
  }

  /**
   * Expand a recurring weekday window ("Tue 15:00-18:00") into one range per
   * matching day of the horizon.
   */
  expandWeekly(
    weekday: Weekday,
    startMinutes: number,
    endMinutes: number,
  ): SlotRange[] {
    return this.daysMatching(weekday).map((dayIndex) => ({
      startSlot: this.slotAt(dayIndex, startMinutes),
      endSlot: this.slotAt(dayIndex, endMinutes),
    }));
  }
}
