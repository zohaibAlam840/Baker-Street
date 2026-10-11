type RouteLoadingVariant = "overview" | "list" | "detail" | "schedule" | "form";

type RouteLoadingProps = {
  label?: string;
  variant?: RouteLoadingVariant;
};

function Skeleton({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-xl bg-[var(--surface-sunken)] motion-reduce:animate-none ${className}`}
    />
  );
}

function PageHeadingSkeleton() {
  return (
    <div aria-hidden="true" className="min-w-0 space-y-2">
      <Skeleton className="h-3 w-24 rounded-full" />
      <Skeleton className="h-7 w-3/4 max-w-80" />
      <Skeleton className="h-4 w-full max-w-lg rounded-full" />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card min-w-0 space-y-3 p-4">
            <Skeleton className="h-3 w-20 rounded-full" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2" aria-hidden="true">
        <Skeleton className="h-52 w-full rounded-2xl" />
        <Skeleton className="h-52 w-full rounded-2xl" />
      </div>
    </>
  );
}

function ListSkeleton() {
  return (
    <>
      <div className="flex gap-2" aria-hidden="true">
        <Skeleton className="h-11 min-w-0 flex-1 rounded-full" />
        <Skeleton className="h-11 w-20 shrink-0 rounded-full sm:w-28" />
      </div>
      <div className="space-y-3" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card flex min-h-24 items-center gap-3 p-4">
            <Skeleton className="size-11 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3 max-w-64 rounded-full" />
              <Skeleton className="h-3 w-full max-w-96 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-hidden="true">
      <div className="card space-y-4 p-4 sm:p-5">
        <Skeleton className="h-5 w-40 rounded-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-36 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    </div>
  );
}

function ScheduleSkeleton() {
  return (
    <>
      <div className="flex items-center gap-2" aria-hidden="true">
        <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
        <Skeleton className="h-11 min-w-0 flex-1 rounded-full" />
        <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
      </div>
      <div className="card min-w-0 overflow-hidden p-3 sm:p-4" aria-hidden="true">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className={index > 2 ? "hidden sm:block" : "block"}>
              <Skeleton className="h-5 w-full rounded-full" />
              <div className="mt-3 space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function FormSkeleton() {
  return (
    <div className="card space-y-5 p-4 sm:p-5" aria-hidden="true">
      <Skeleton className="h-5 w-40 rounded-full" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-24 rounded-full" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        ))}
      </div>
      <Skeleton className="h-11 w-full rounded-full sm:w-40" />
    </div>
  );
}

export function RouteLoading({
  label = "Loading this page",
  variant = "overview",
}: RouteLoadingProps) {
  return (
    <section
      className="min-w-0 space-y-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <PageHeadingSkeleton />
      {variant === "overview" && <OverviewSkeleton />}
      {variant === "list" && <ListSkeleton />}
      {variant === "detail" && <DetailSkeleton />}
      {variant === "schedule" && <ScheduleSkeleton />}
      {variant === "form" && <FormSkeleton />}
      <span className="sr-only">{label}. Please wait.</span>
    </section>
  );
}
