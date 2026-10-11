import { NextResponse } from "next/server";
import { can, type Permission } from "./roles";
import { getSession, type Session } from "./session";

export async function requireApiSession(): Promise<Session | NextResponse> {
  const session = await getSession();
  return session ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

export async function authorizeApi(permission: Permission): Promise<Session | NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!can(session.role, permission)) return NextResponse.json({ error: "You do not have permission for this operation." }, { status: 403 });
  return session;
}

export function isApiError(value: Session | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}
