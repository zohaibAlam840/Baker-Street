import Link from "next/link";

import { signIn } from "@/lib/auth/actions";
import { ROLES, ROLE_DEFINITIONS } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="mx-auto max-w-[60rem] px-4 py-12 sm:px-6 sm:py-16">
      <Link
        href="/"
        className="text-xs text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--ink-primary)]"
      >
        ← Baker Street Scheduling
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-[var(--ink-primary)]">
        Sign in
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
        Choose a role to see the application as that person sees it. Each role
        gets different navigation and different permissions.
      </p>

      {/*
        Being loud about this on purpose. A sign-in screen that looks real is
        exactly the thing someone demonstrates to a client without mentioning
        that it verifies nothing.
      */}
      <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-[var(--border-ring)] bg-[var(--surface-1)] p-4">
        <span
          aria-hidden
          className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
          style={{ background: "var(--status-warning)" }}
        />
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
          <span className="font-medium text-[var(--ink-primary)]">
            This is not authentication.
          </span>{" "}
          There is no password and nothing is verified — it is a role switcher
          so the permission model can be reviewed before Baker Street chooses an
          identity provider. Real sign-in, roles read from the database, and
          row-level security all have to be in place before any real patient
          information goes near this.
        </p>
      </div>

      {error === "unknown-role" && (
        <p className="mt-4 text-sm" style={{ color: "var(--status-critical)" }}>
          That role does not exist. Pick one below.
        </p>
      )}

      {/* One form per role: the role is bound into the action, so nothing
          depends on a button's name/value surviving the submission. */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {ROLES.map((role) => {
          const definition = ROLE_DEFINITIONS[role];
          return (
            <form key={role} action={signIn.bind(null, role)}>
            <button
              type="submit"
              className="group w-full rounded-2xl border border-[var(--border-ring)] bg-[var(--surface-1)] p-4 text-left shadow-[var(--shadow-card)] transition-colors hover:bg-[var(--surface-sunken)]"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-[var(--ink-primary)]">
                  {definition.label}
                </span>
                <span className="text-xs text-[var(--ink-muted)]">
                  {definition.headcount}
                </span>
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-[var(--ink-secondary)]">
                {definition.description}
              </span>
              <span className="mt-2 block text-xs text-[var(--ink-muted)]">
                Sees:{" "}
                {definition.scope === "own"
                  ? "own schedule only"
                  : definition.scope === "caseload"
                    ? "own caseload"
                    : definition.scope === "department"
                      ? "own department"
                      : "whole organisation"}
                {" · "}
                {definition.permissions.length}{" "}
                {definition.permissions.length === 1 ? "permission" : "permissions"}
              </span>
            </button>
            </form>
          );
        })}
      </div>
    </div>
  );
}
