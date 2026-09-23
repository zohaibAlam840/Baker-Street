import { isSupabaseConfigured } from "../data/snapshot";
import { startOfWeek } from "../domain/time";
import { WEEK_START } from "../testing/scenario";

export const SCHEDULING_TIMEZONE =
  process.env.SCHEDULING_TIMEZONE ?? "America/New_York";

/**
 * Which week a page opens on when the URL does not say.
 *
 * On synthetic data that is the acceptance scenario's week — opening a fresh
 * clone on the current week would show an empty calendar and look broken.
 * With a real database it is simply this week.
 */
export function defaultWeekStart(now: Date = new Date()): string {
  return isSupabaseConfigured()
    ? startOfWeek(now, SCHEDULING_TIMEZONE)
    : WEEK_START;
}

/**
 * What "today" means on screen.
 *
 * On synthetic data it is fixed to the Wednesday of the fixture week, so
 * "today's appointments" is never an empty list and screenshots stay stable.
 * With a real database it is simply today.
 */
export function demoToday(now: Date = new Date()): Date {
  if (isSupabaseConfigured()) return now;
  const [year, month, day] = WEEK_START.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 2, 16)); // Wednesday, midday local
}
