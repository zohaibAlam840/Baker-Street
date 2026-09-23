import type { ServiceSummaryRow } from "@/lib/scheduling/summary";
import type { WeekBlock, WeekView } from "@/lib/scheduling/weekView";

/**
 * Table views — the colour-free twin of the grid. Every value shown in the
 * calendar is reachable here, which is what lets the grid use tints and a
 * hover title without gating any information behind them.
 *
 * Columns of numbers use `tabular-nums` so the digits align.
 */

const cell = "px-3 py-2 text-left align-top";
const numCell = "px-3 py-2 text-right align-top tabular-nums";
const head =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]";
const numHead = `${head} text-right`;

function fmt(value: number | null, suffix = ""): string {
  return value == null ? "—" : `${value}${suffix}`;
}

/**
 * The four numbers the spec insists must stay distinct: what is scheduled,
 * the clinical floor, the clinical target, and what the payer authorized.
 * Presenting them in one row is the clearest possible argument for why they
 * are four columns in the database and not one.
 */
export function ServiceSummaryTable({ rows }: { rows: ServiceSummaryRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <caption className="sr-only">
          Scheduled hours against clinical requirements and authorization, by service
        </caption>
        <thead>
          <tr className="border-b border-[var(--rule-hairline)]">
            <th scope="col" className={head}>Service</th>
            <th scope="col" className={numHead}>Scheduled</th>
            <th scope="col" className={numHead}>Clinical min</th>
            <th scope="col" className={numHead}>Target</th>
            <th scope="col" className={numHead}>Authorized</th>
            <th scope="col" className={numHead}>Unused auth.</th>
            <th scope="col" className={head}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.service_id}
              className="border-b border-[var(--rule-hairline)] last:border-0"
            >
              <th scope="row" className={`${cell} font-normal`}>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`dept-${row.departmentSlot} inline-block size-2.5 shrink-0 rounded-sm`}
                    style={{ background: "var(--dept)" }}
                  />
                  <span>
                    <span className="block text-[var(--ink-primary)]">
                      {row.service_name}
                    </span>
                    <span className="block text-xs text-[var(--ink-muted)]">
                      {row.department}
                      {row.required && " · required"}
                    </span>
                  </span>
                </span>
              </th>
              <td className={numCell}>
                <span className="text-[var(--ink-primary)]">
                  {row.scheduled_hours}h
                </span>
                <span className="block text-xs text-[var(--ink-muted)]">
                  {row.scheduled_sessions}{" "}
                  {row.scheduled_sessions === 1 ? "session" : "sessions"}
                </span>
              </td>
              <td className={numCell}>{fmt(row.minimum_hours, "h")}</td>
              <td className={numCell}>{fmt(row.target_hours, "h")}</td>
              <td className={numCell}>{fmt(row.authorized_hours, "h")}</td>
              <td className={numCell}>{fmt(row.unused_authorization, "h")}</td>
              <td className={cell}>
                <StatusPill met={row.met} shortfall={row.shortfall} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Status never rests on colour: the dot is always paired with its label. */
function StatusPill({ met, shortfall }: { met: boolean; shortfall: string | null }) {
  const color = !met
    ? "var(--status-critical)"
    : shortfall
      ? "var(--status-warning)"
      : "var(--status-good)";
  const label = !met ? (shortfall ?? "Not met") : (shortfall ?? "Met");

  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--ink-secondary)]">
      <span
        aria-hidden
        className="inline-block size-1.5 shrink-0 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

export function AppointmentTable({ view }: { view: WeekView }) {
  const byDay = new Map<number, WeekBlock[]>();
  for (const block of view.blocks) {
    const bucket = byDay.get(block.dayIndex);
    if (bucket) bucket.push(block);
    else byDay.set(block.dayIndex, [block]);
  }

  const days = view.days.filter((day) => byDay.has(day.dayIndex));

  if (days.length === 0) {
    return (
      <p className="rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4 text-sm text-[var(--ink-secondary)]">
        Nothing scheduled this week.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)]">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">Every appointment this week</caption>
        <thead>
          <tr className="border-b border-[var(--rule-hairline)]">
            <th scope="col" className={head}>Day</th>
            <th scope="col" className={head}>Time</th>
            <th scope="col" className={head}>Service</th>
            <th scope="col" className={head}>With</th>
            <th scope="col" className={head}>Location</th>
            <th scope="col" className={head}>Flexibility</th>
          </tr>
        </thead>
        <tbody>
          {days.flatMap((day) =>
            (byDay.get(day.dayIndex) ?? [])
              .sort((a, b) => a.startMinutes - b.startMinutes)
              .map((block, index) => (
                <tr
                  key={`${block.id}-${block.dayIndex}`}
                  className="border-b border-[var(--rule-hairline)] last:border-0"
                >
                  <td className={`${cell} whitespace-nowrap text-[var(--ink-secondary)]`}>
                    {index === 0 ? `${day.weekdayLabel} ${day.dayLabel}` : ""}
                  </td>
                  <td className={`${cell} whitespace-nowrap tabular-nums`}>
                    {block.startLabel}–{block.endLabel}
                  </td>
                  <td className={cell}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`dept-${block.departmentSlot} inline-block size-2.5 shrink-0 rounded-sm`}
                        style={{ background: "var(--dept)" }}
                      />
                      {block.serviceName}
                    </span>
                  </td>
                  <td className={cell}>{block.counterpart}</td>
                  <td className={`${cell} text-[var(--ink-secondary)]`}>
                    {block.telehealth ? "Telehealth" : (block.locationName ?? "—")}
                  </td>
                  <td className={`${cell} text-[var(--ink-secondary)]`}>
                    {block.flexibility.charAt(0) + block.flexibility.slice(1).toLowerCase()}
                  </td>
                </tr>
              )),
          )}
        </tbody>
      </table>
    </div>
  );
}
