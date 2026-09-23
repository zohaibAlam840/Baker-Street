import Link from "next/link";

import { ROLE_DEFINITIONS, navFor } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Where a permission check sends someone who is signed in but not allowed.
 *
 * It names the role they hold, says what that role can do, and offers the
 * places they can actually go. A bare "403" teaches people the software is
 * broken rather than that they are in the wrong seat.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const { permission } = await searchParams;
  const session = await getSession();

  if (!session) {
    return (
      <div className="mx-auto max-w-[48rem] px-4 py-16 sm:px-6">
        <h1 className="text-xl font-semibold text-[var(--ink-primary)]">
          Please sign in
        </h1>
        <Link
          href="/login"
          className="mt-4 inline-block rounded-md bg-[var(--dept-1)] px-4 py-2 text-sm font-medium text-white"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const definition = ROLE_DEFINITIONS[session.role];
  const nav = navFor(session.role);

  return (
    <div className="mx-auto max-w-[48rem] px-4 py-16 sm:px-6">
      <h1 className="text-xl font-semibold text-[var(--ink-primary)]">
        That page is not part of your role
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
        You are signed in as <strong>{definition.label}</strong>
        {permission && (
          <>
            , which does not include{" "}
            <code className="rounded bg-[var(--surface-sunken)] px-1 py-0.5 text-xs">
              {permission}
            </code>
          </>
        )}
        . {definition.description}
      </p>

      {nav.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-[var(--ink-primary)]">
            Where you can go
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-3 transition-colors hover:bg-[var(--surface-sunken)]"
                >
                  <span className="block text-sm font-medium text-[var(--ink-primary)]">
                    {item.label}
                  </span>
                  <span className="block text-xs text-[var(--ink-muted)]">
                    {item.description}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-8 text-xs text-[var(--ink-secondary)]">
        If this is the wrong role for you,{" "}
        <Link href="/login" className="underline underline-offset-4">
          switch role
        </Link>
        . In the finished system your role comes from your account, not a menu.
      </p>
    </div>
  );
}
