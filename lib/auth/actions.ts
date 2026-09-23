"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ROLE_DEFINITIONS, isRole } from "./roles";
import { SESSION_COOKIE } from "./session";

/**
 * Demo sign-in: pick a role. Replaced wholesale by real authentication.
 *
 * The role is bound into the action rather than read out of the form. A
 * `<button name="role" value="...">` inside a server-action form does not
 * reliably reach the action's FormData, which silently produced an
 * "unknown role" error for every button on the sign-in screen.
 */
export async function signIn(role: string) {
  if (!isRole(role)) {
    redirect("/login?error=unknown-role");
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, role, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8, // a working day
  });

  redirect(ROLE_DEFINITIONS[role].home);
}

export async function signOut() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/");
}
