export default function Loading() {
  return (
    <main className="mx-auto max-w-7xl animate-pulse space-y-4 p-6" aria-label="Loading page">
      <div className="h-8 w-56 rounded bg-[var(--surface-sunken)]" />
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-36 rounded-xl bg-[var(--surface-sunken)]" />
        ))}
      </div>
    </main>
  );
}
