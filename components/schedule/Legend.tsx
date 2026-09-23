/**
 * The legend is always present when two or more departments are on screen, so
 * identity never rests on colour alone — every block is also labelled, and the
 * table view carries the same information with no colour at all.
 */
export function Legend({
  departments,
  showFlexibility = true,
}: {
  departments: { name: string; slot: number }[];
  showFlexibility?: boolean;
}) {
  if (departments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--ink-secondary)]">
      {departments.length > 1 &&
        departments.map((department) => (
          <span key={department.name} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`dept-${department.slot} inline-block size-2.5 rounded-sm`}
              style={{ background: "var(--dept)" }}
            />
            {department.name}
          </span>
        ))}

      {showFlexibility && (
        <>
          {departments.length > 1 && (
            <span aria-hidden className="h-3 w-px bg-[var(--rule-hairline)]" />
          )}
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="text-[0.5rem]">
              {"■"}
            </span>
            Locked
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="text-[0.5rem]">
              {"▲"}
            </span>
            Protected
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-sm border border-[var(--rule-hairline)] bg-[var(--surface-blocked)]"
            />
            Unavailable / school
          </span>
        </>
      )}
    </div>
  );
}
