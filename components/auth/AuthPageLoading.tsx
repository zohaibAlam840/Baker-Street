import { IconLogo } from "@/components/shell/icons";

export function AuthPageLoading({ label = "Loading the secure account page…" }: { label?: string }) {
  return (
    <main
      className="grid min-h-dvh place-items-center bg-[var(--surface-1)] p-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="w-full max-w-sm text-center">
        <IconLogo className="mx-auto size-10 text-[var(--brand)]" />
        <span
          aria-hidden="true"
          className="mx-auto mt-6 block size-9 animate-spin rounded-full border-[3px] border-[var(--brand-tint)] border-r-[var(--brand)] motion-reduce:animate-none"
        />
        <p className="mt-4 text-base font-semibold text-[var(--ink-primary)]">{label}</p>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">
          Please wait while Baker Street prepares a secure connection.
        </p>
      </div>
    </main>
  );
}
