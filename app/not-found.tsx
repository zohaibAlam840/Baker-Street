import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center p-6">
      <div className="card w-full p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--ink-primary)]">That record could not be found.</h1>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">It may be outside the selected week, removed, or unavailable to your role.</p>
        <Link href="/dashboard" className="mt-5 inline-block rounded-full bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white">Return to dashboard</Link>
      </div>
    </main>
  );
}
