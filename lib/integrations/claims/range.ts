const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(date: Date) { return date.toISOString().slice(0, 10); }

export function claimsDateRange(start: string | null, end: string | null, now = new Date()) {
  const defaultEnd = dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
  const defaultStart = dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)));
  const startDate = start && DATE.test(start) ? start : defaultStart;
  const endDateExclusive = end && DATE.test(end) ? end : defaultEnd;
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDateExclusive}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 93 * 86_400_000) {
    throw new Error("CLAIMS_DATE_RANGE_INVALID");
  }
  return { startDate, endDateExclusive };
}
