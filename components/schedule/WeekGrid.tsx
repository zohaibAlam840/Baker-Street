import type { WeekBlock, WeekView } from "@/lib/scheduling/weekView";

const HOUR_HEIGHT = 56; // px

/**
 * LOCKED and PROTECTED carry a glyph as well as a border weight, so the
 * distinction never rests on colour alone. FLEXIBLE is the unmarked default —
 * marking the common case would make every block shout.
 */
const FLEXIBILITY_MARK: Record<WeekBlock["flexibility"], { glyph: string; title: string } | null> = {
  LOCKED: { glyph: "■", title: "Locked — cannot be moved" },
  PROTECTED: { glyph: "▲", title: "Protected — movable only at high cost" },
  FLEXIBLE: null,
};

function positionFor(
  startMinutes: number,
  endMinutes: number,
  axisStartMinutes: number,
): { top: number; height: number } {
  const top = ((startMinutes - axisStartMinutes) / 60) * HOUR_HEIGHT;
  const height = ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT;
  return { top, height };
}

export function WeekGrid({ view }: { view: WeekView }) {
  const { axisStartMinutes, axisEndMinutes } = view;
  const totalHeight = ((axisEndMinutes - axisStartMinutes) / 60) * HOUR_HEIGHT;

  const hours: number[] = [];
  for (let m = axisStartMinutes; m <= axisEndMinutes; m += 60) hours.push(m);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[56rem]">
        {/* Day headings */}
        <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-[var(--rule-hairline)]">
          <div aria-hidden />
          {view.days.map((day) => (
            <div
              key={day.date}
              className="px-2 pb-2 text-center"
              data-today={day.isToday || undefined}
            >
              <div className="text-xs font-medium text-[var(--ink-secondary)]">
                {day.weekdayLabel}
              </div>
              <div
                className={
                  day.isToday
                    ? "text-sm font-semibold text-[var(--ink-primary)]"
                    : "text-sm text-[var(--ink-muted)]"
                }
              >
                {day.dayLabel}
              </div>
            </div>
          ))}
        </div>

        {/* Grid body */}
        <div className="grid grid-cols-[3.5rem_repeat(7,1fr)]">
          {/* Time gutter */}
          <div className="relative" style={{ height: totalHeight }}>
            {hours.slice(0, -1).map((minutes) => (
              <div
                key={minutes}
                className="absolute right-2 -translate-y-1/2 text-[0.6875rem] tabular-nums text-[var(--ink-muted)]"
                style={{ top: ((minutes - axisStartMinutes) / 60) * HOUR_HEIGHT }}
              >
                {String(Math.floor(minutes / 60)).padStart(2, "0")}:00
              </div>
            ))}
          </div>

          {view.days.map((day) => {
            const layers = view.layers.filter((l) => l.dayIndex === day.dayIndex);
            const blocks = view.blocks.filter((b) => b.dayIndex === day.dayIndex);

            return (
              <div
                key={day.date}
                // The column defaults to blocked; availability punches lighter
                // holes in it. That way "when can this patient be seen?" is the
                // shape you read, rather than having to infer it from absence.
                className="relative border-l border-[var(--rule-hairline)] bg-[var(--surface-blocked)]"
                style={{ height: totalHeight }}
              >
                {/* Background: availability and restrictions */}
                {layers.map((layer, index) => {
                  const { top, height } = positionFor(
                    layer.startMinutes,
                    layer.endMinutes,
                    axisStartMinutes,
                  );
                  const isRestricted = layer.kind === "restricted";
                  return (
                    <div
                      key={`${layer.kind}-${index}`}
                      className={
                        isRestricted
                          ? "pointer-events-none absolute inset-x-0 bg-[var(--surface-blocked)]"
                          : "pointer-events-none absolute inset-x-0 bg-[var(--surface-1)]"
                      }
                      style={{ top, height }}
                    >
                      {isRestricted && height >= 28 && (
                        <span className="absolute left-1.5 top-1 text-[0.625rem] uppercase tracking-wide text-[var(--ink-muted)]">
                          {layer.label}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* Hour rules sit above the background layers, or the
                    availability fill would hide them. */}
                {hours.slice(1, -1).map((minutes) => (
                  <div
                    key={minutes}
                    className="pointer-events-none absolute inset-x-0 border-t border-[var(--rule-hairline)]"
                    style={{ top: ((minutes - axisStartMinutes) / 60) * HOUR_HEIGHT }}
                  />
                ))}

                {/* Appointments */}
                {blocks.map((block) => {
                  const { top, height } = positionFor(
                    block.startMinutes,
                    block.endMinutes,
                    axisStartMinutes,
                  );
                  const mark = FLEXIBILITY_MARK[block.flexibility];
                  // Only label inside the block when the text actually fits.
                  const showCounterpart = height >= 48;
                  const showTime = height >= 34;

                  return (
                    <article
                      key={`${block.id}-${block.dayIndex}`}
                      className={`dept-${block.departmentSlot} absolute left-px right-px overflow-hidden rounded-md pl-2 pr-1.5 py-1 text-left`}
                      style={{
                        top: top + 1,
                        height: Math.max(height - 2, 16),
                        background:
                          "color-mix(in srgb, var(--dept) 14%, var(--surface-1))",
                        boxShadow: "inset 3px 0 0 0 var(--dept)",
                      }}
                      title={`${block.serviceName} · ${block.startLabel}–${block.endLabel} · ${block.counterpart}${
                        block.locationName ? ` · ${block.locationName}` : ""
                      }${mark ? ` · ${mark.title}` : ""}`}
                    >
                      <div className="flex items-start gap-1">
                        <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold leading-tight text-[var(--ink-primary)]">
                          {block.serviceName}
                        </span>
                        {mark && (
                          <span
                            aria-hidden
                            className="shrink-0 text-[0.5rem] leading-none pt-0.5 text-[var(--ink-secondary)]"
                          >
                            {mark.glyph}
                          </span>
                        )}
                      </div>
                      {showTime && (
                        <div className="truncate text-[0.625rem] tabular-nums leading-tight text-[var(--ink-secondary)]">
                          {block.startLabel}–{block.endLabel}
                        </div>
                      )}
                      {showCounterpart && (
                        <div className="truncate text-[0.625rem] leading-tight text-[var(--ink-muted)]">
                          {block.counterpart}
                        </div>
                      )}
                      {mark && <span className="sr-only">{mark.title}</span>}
                    </article>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
