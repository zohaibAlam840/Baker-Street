/**
 * Chart primitives.
 *
 * Inline SVG rather than a charting library: these are four small, fixed
 * shapes, and a library would ship a rendering engine to draw them.
 *
 * Rules held throughout:
 *  · thin marks, hairline axes, generous padding — no thick saturated blocks
 *  · every value shown here is also present as text nearby, so nothing is
 *    reachable only by hovering
 *  · labels are selective; never a number on every point
 *
 * The demographic bars carry a diagonal hatch, matching the reference design
 * the client signed off. It is kept deliberately low-contrast: a dense,
 * high-contrast field of angled lines vibrates and is a vestibular risk, and
 * the hatch here is decoration on top of a solid fill rather than the thing
 * carrying the value.
 */

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Segmented bar — the "barcode" strip under a stat
// ---------------------------------------------------------------------------

export interface SegmentBarProps {
  value: number;
  total: number;
  /** Labels for each end of the strip. */
  leftLabel: string;
  rightLabel: string;
  leftValue: string;
  rightValue: string;
  /** Brand green by default; pass a categorical token to identify a series. */
  color?: string;
  ticks?: number;
}

export function SegmentBar({
  value,
  total,
  leftLabel,
  rightLabel,
  leftValue,
  rightValue,
  color = "var(--brand)",
  ticks = 44,
}: SegmentBarProps) {
  const filled = total > 0 ? Math.round((value / total) * ticks) : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between text-[0.6875rem] text-[var(--ink-secondary)]">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>

      <div
        className="mt-1.5 flex h-7 items-stretch gap-[2px]"
        role="img"
        aria-label={`${leftValue} ${leftLabel}, ${rightValue} ${rightLabel}`}
      >
        {Array.from({ length: ticks }, (_, i) => (
          <span
            key={i}
            className="flex-1 rounded-[1px]"
            style={{
              background: i < filled ? color : "var(--rule-hairline)",
            }}
          />
        ))}
      </div>

      <div className="mt-1.5 flex items-baseline justify-between text-xs font-medium tabular-nums text-[var(--ink-primary)]">
        <span>{leftValue}</span>
        <span className="text-[var(--ink-muted)]">{rightValue}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Area sparkline
// ---------------------------------------------------------------------------

/** Catmull-Rom through the points, converted to cubic beziers. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  }

  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    // Tension 6 keeps the curve close to the data — a looser curve would
    // overshoot and imply values that are not in the series.
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
  }
  return d;
}

export interface AreaChartProps {
  values: number[];
  labels: string[];
  /** Index to call out with a dot and a value badge. Defaults to the peak. */
  highlight?: number;
  color?: string;
  height?: number;
  /** Rendered under the plot as an accessible equivalent. */
  caption?: string;
  /** Text for the floating value pill; defaults to the highlighted value. */
  badge?: string;
}

export function AreaChart({
  values,
  labels,
  highlight,
  color = "var(--brand)",
  height = 132,
  caption,
  badge,
}: AreaChartProps) {
  if (values.length === 0) return null;

  const width = 320;
  const padY = 14;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const points = values.map((value, i) => ({
    x: (i / Math.max(1, values.length - 1)) * width,
    y: padY + (1 - (value - min) / span) * (height - padY * 2),
  }));

  const line = smoothPath(points);
  const area = `${line} L${width},${height} L0,${height} Z`;

  const peak = highlight ?? values.indexOf(Math.max(...values));
  const peakPoint = points[peak];
  // The reference floats the called-out value in a pill above the point.
  const badgeText = badge ?? String(values[peak] ?? "");
  const badgeWidth = Math.max(34, badgeText.length * 8 + 16);
  const badgeX = Math.min(width - badgeWidth / 2, Math.max(badgeWidth / 2, peakPoint?.x ?? 0));
  const gradientId = `area-${Math.round(values.reduce((a, b) => a + b, 0))}-${values.length}`;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={caption ?? `Trend across ${labels.length} points`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} />

        {peakPoint && (
          <>
            <line
              x1={peakPoint.x}
              y1={peakPoint.y}
              x2={peakPoint.x}
              y2={height}
              stroke="var(--rule-hairline)"
              strokeWidth={1}
            />
            {/* 2px surface ring so the dot reads against the line it sits on. */}
            <circle
              cx={peakPoint.x}
              cy={peakPoint.y}
              r={4.5}
              fill={color}
              stroke="var(--surface-1)"
              strokeWidth={2}
            />

            <g transform={`translate(${badgeX}, ${Math.max(14, peakPoint.y - 20)})`}>
              <rect
                x={-badgeWidth / 2}
                y={-11}
                width={badgeWidth}
                height={22}
                rx={11}
                fill={color}
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="11"
                fontWeight="600"
                fill="#ffffff"
              >
                {badgeText}
              </text>
            </g>
          </>
        )}
      </svg>

      <div className="mt-1 flex justify-between text-[0.625rem] text-[var(--ink-muted)]">
        {/* Selective labels only: first, the called-out point, and last. */}
        <span>{labels[0]}</span>
        {peak > 0 && peak < labels.length - 1 && <span>{labels[peak]}</span>}
        <span>{labels[labels.length - 1]}</span>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Multi-line chart — several series over the same days
// ---------------------------------------------------------------------------

export interface MultiLineSeries {
  label: string;
  values: number[];
  color: string;
}

export function MultiLineChart({
  series,
  labels,
  height = 150,
}: {
  series: MultiLineSeries[];
  labels: string[];
  height?: number;
}) {
  if (series.length === 0) return null;

  const width = 320;
  const padY = 12;
  const max = Math.max(1, ...series.flatMap((s) => s.values));

  const pathFor = (values: number[]) =>
    smoothPath(
      values.map((value, i) => ({
        x: (i / Math.max(1, values.length - 1)) * width,
        y: padY + (1 - value / max) * (height - padY * 2),
      })),
    );

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={series
          .map((s) => `${s.label}: ${s.values.join(", ")}`)
          .join("; ")}
      >
        {series.map((s) => (
          <path
            key={s.label}
            d={pathFor(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
      </svg>

      {/* A legend is always present for two or more series. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <li
            key={s.label}
            className="flex items-center gap-1.5 text-[0.6875rem] text-[var(--ink-secondary)]"
          >
            <span
              aria-hidden
              className="inline-block h-0.5 w-3 rounded-full"
              style={{ background: s.color }}
            />
            {s.label}
            <span className="tabular-nums text-[var(--ink-muted)]">
              {s.values.reduce((a, b) => a + b, 0)}h
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-1 flex justify-between text-[0.625rem] text-[var(--ink-muted)]">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Vertical bars — the demographic breakdown, as the reference draws it
// ---------------------------------------------------------------------------

export interface VerticalBand {
  label: string;
  caption: string;
  value: number;
  share: number;
}

export function VerticalBars({
  bands,
  highlight,
}: {
  bands: VerticalBand[];
  /** Index to call out, as the reference highlights one column. */
  highlight?: number;
}) {
  const max = Math.max(...bands.map((b) => b.value), 1);

  return (
    <div>
      <div className="flex items-end gap-2 sm:gap-3" style={{ height: 210 }}>
        {bands.map((band, index) => {
          const isHighlighted = index === highlight;
          return (
            <div key={band.label} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              <div className="mb-2 text-center">
                <div className="truncate text-[0.625rem] text-[var(--ink-muted)]">
                  {band.caption}
                </div>
                <div className="text-base font-semibold tabular-nums text-[var(--ink-primary)]">
                  {band.value}
                </div>
              </div>

              <div
                className="relative w-full rounded-t-xl"
                style={{
                  height: `${Math.max(6, (band.value / max) * 100)}%`,
                  // The called-out column graduates green into yellow, as the
                  // reference does. Mixing the two into one flat tone instead
                  // produces a muddy olive that reads as a third category.
                  background: isHighlighted
                    ? "linear-gradient(180deg, color-mix(in srgb, var(--brand) 88%, white) 0%, var(--dept-2) 100%)"
                    : "color-mix(in srgb, var(--brand) 82%, white)",
                }}
                role="img"
                aria-label={`${band.label}: ${band.value} patients, ${band.share.toFixed(0)}%`}
              >
                {/* Decoration only — the height carries the value. */}
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-t-xl opacity-25"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(45deg, transparent 0 5px, rgba(255,255,255,0.65) 5px 7px)",
                  }}
                />
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-[3px] rounded-t-xl bg-white/70"
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Axis labels and the share chips, below the bars. */}
      <div className="mt-2 flex gap-2 sm:gap-3">
        {bands.map((band) => (
          <div key={band.label} className="min-w-0 flex-1 text-center">
            <div className="truncate text-[0.625rem] text-[var(--ink-secondary)]">
              {band.label}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {bands.map((band) => (
          <span
            key={band.label}
            className="rounded-full bg-[var(--surface-sunken)] px-2.5 py-1 text-[0.625rem] tabular-nums text-[var(--ink-secondary)]"
          >
            {band.label}: {band.share.toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal band bars — used where space is narrow
// ---------------------------------------------------------------------------

export interface BandBarsProps {
  bands: { label: string; value: number; share: number }[];
  color?: string;
}

export function BandBars({ bands, color = "var(--brand)" }: BandBarsProps) {
  const max = Math.max(...bands.map((b) => b.value), 1);

  return (
    <div className="space-y-2.5">
      {bands.map((band) => (
        <div key={band.label} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-[0.6875rem] tabular-nums text-[var(--ink-secondary)]">
            {band.label}
          </span>
          <span className="flex h-6 min-w-0 flex-1 items-center">
            <span
              className="h-full rounded-md"
              style={{
                width: `${Math.max(2, (band.value / max) * 100)}%`,
                background: color,
                opacity: 0.25 + 0.75 * (band.value / max),
              }}
            />
          </span>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-[var(--ink-primary)]">
            {band.value}
            <span className="ml-1 text-[var(--ink-muted)]">
              {band.share.toFixed(0)}%
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card scaffolding
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`card p-4 ${className}`}>{children}</section>;
}

export function CardHeader({
  title,
  action,
  sub,
}: {
  title: string;
  action?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold tracking-tight text-[var(--ink-primary)]">
          {title}
        </h2>
        {sub && <div className="mt-0.5 text-xs text-[var(--ink-secondary)]">{sub}</div>}
      </div>
      {action}
    </div>
  );
}

/** A small up/down figure. Direction is paired with an arrow, never colour alone. */
export function Delta({ value, good }: { value: string; good: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs tabular-nums"
      style={{ color: good ? "var(--status-good)" : "var(--status-critical)" }}
    >
      <span aria-hidden>{good ? "↗" : "↘"}</span>
      {value}
    </span>
  );
}
