import type { Instrumentation } from "next";

import { logEvent } from "@/lib/observability/logger";

function safeDigest(error: unknown) {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return undefined;
  }
  const digest = String(error.digest);
  return /^[a-zA-Z0-9._-]{1,128}$/.test(digest) ? digest : undefined;
}

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  logEvent("error", "request.unhandled_error", {
    error_digest: safeDigest(error),
    method: request.method,
    route_path: context.routePath,
    route_type: context.routeType,
    router_kind: context.routerKind,
    render_source: context.renderSource,
    revalidate_reason: context.revalidateReason,
  });
};
