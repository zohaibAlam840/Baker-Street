/**
 * Timezone-aware wall-clock helpers.
 *
 * Availability, school hours and clinic hours are all expressed as local wall
 * clock ("Tuesday 15:00-18:00"), while appointments are stored as absolute
 * instants. Every comparison between the two has to go through here, or DST
 * weeks will silently shift a patient's school block by an hour.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekday: Weekday;
}

const WEEKDAY_INDEX: Record<string, Weekday> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Break an instant into its local wall-clock parts in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  // Intl renders midnight as hour 24 in some engines; normalise it.
  const hour = Number(get("hour")) % 24;

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Seconds and below are unaffected by any real-world zone offset.
  return asIfUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * Resolve a local wall-clock time in `timeZone` to an absolute instant.
 *
 * Two passes: the first guess uses the offset at the naive UTC instant, the
 * second corrects it when that guess landed on the other side of a DST edge.
 */
export function zonedTimeToInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** Parse "HH:MM" or "HH:MM:SS" (Postgres `time`) into minutes past midnight. */
export function parseClockTime(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** Inverse of {@link parseClockTime}, rendered as "HH:MM". */
export function formatClockTime(minutesPastMidnight: number): string {
  const hour = Math.floor(minutesPastMidnight / 60);
  const minute = minutesPastMidnight % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Parse a "YYYY-MM-DD" date string without going through local time. */
export function parseDateOnly(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

/** Render an instant as "YYYY-MM-DD" in `timeZone`. */
export function formatDateOnly(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Shift a "YYYY-MM-DD" by whole days, without touching local time. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDateOnly(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * The "YYYY-MM-DD" of the week containing `instant`.
 *
 * Weekly figures — authorized hours per week, required sessions per week —
 * only add up if the horizon covers a whole week. Anchoring a horizon on
 * whatever day the user happened to ask about would silently drop the
 * appointments before it and under-count every weekly total.
 */
export function startOfWeek(
  instant: Date,
  timeZone: string,
  weekStartsOn: Weekday = 1, // Monday
): string {
  const p = zonedParts(instant, timeZone);
  const back = (p.weekday - weekStartsOn + 7) % 7;
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * Whether an instant falls inside a date-only effective range. Both bounds are
 * inclusive and either may be null, which the schema uses for "always".
 */
export function withinEffectiveRange(
  instant: Date,
  timeZone: string,
  effectiveStart: string | null,
  effectiveEnd: string | null,
): boolean {
  const day = formatDateOnly(instant, timeZone);
  if (effectiveStart && day < effectiveStart) return false;
  if (effectiveEnd && day > effectiveEnd) return false;
  return true;
}
