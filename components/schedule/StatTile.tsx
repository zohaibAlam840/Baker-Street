import type { ReactNode } from "react";

/**
 * A stat tile, not a chart. "27 of 30 hours" is one number with a context —
 * a bar chart of a single value would be a chart that misses its point.
 *
 * Values use the font's proportional figures; `tabular-nums` is reserved for
 * the table view, where digits have to line up in columns.
 */
export function StatTile({
  label,
  value,
  unit,
  detail,
  meter,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  unit?: string;
  detail?: ReactNode;
  /** `slot` identifies a department; omit it to use the brand colour. */
  meter?: { value: number; max: number; slot?: number };
  tone?: "neutral" | "good" | "warning";
}) {
  const toneColor =
    tone === "good"
      ? "var(--status-good)"
      : tone === "warning"
        ? "var(--status-warning)"
        : undefined;

  return (
    <div className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4">
      <div className="text-xs font-medium text-[var(--ink-secondary)]">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-semibold leading-none text-[var(--ink-primary)]">
          {value}
        </span>
        {unit && (
          <span className="text-sm text-[var(--ink-muted)]">{unit}</span>
        )}
      </div>

      {meter && <Meter value={meter.value} max={meter.max} slot={meter.slot} />}

      {detail && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--ink-secondary)]">
          {toneColor && (
            <span
              aria-hidden
              className="inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: toneColor }}
            />
          )}
          <span>{detail}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The unfilled track is a lighter step of the fill's own hue, so the state
 * reads across the whole bar rather than only where it is filled.
 */
export function Meter({
  value,
  max,
  slot,
}: {
  value: number;
  max: number;
  /** A categorical slot for series identity; omitted uses the brand colour. */
  slot?: number;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;

  return (
    <div
      className={`${slot == null ? "" : `dept-${slot}`} mt-3 h-1.5 w-full overflow-hidden rounded-full`}
      style={{
        background: slot == null
          ? "color-mix(in srgb, var(--brand) 18%, var(--surface-1))"
          : "color-mix(in srgb, var(--dept) 20%, var(--surface-1))",
      }}
      role="img"
      aria-label={`${value} of ${max}`}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: slot == null ? "var(--brand)" : "var(--dept)" }}
      />
    </div>
  );
}
