import "server-only";

import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization");
  if (!secret || secret.length < 16 || !supplied?.startsWith("Bearer ")) return false;

  const expectedBuffer = Buffer.from(`Bearer ${secret}`);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
