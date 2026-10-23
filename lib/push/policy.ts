export type PushSeverity = "INFO" | "WARNING" | "CRITICAL";
export type PushFailureOutcome = "RETRY" | "PERMANENT_FAILURE";

export interface ClassifiedPushFailure {
  outcome: PushFailureOutcome;
  errorCode: string;
  removeSubscription: boolean;
}

function statusCode(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function classifyPushFailure(error: unknown): ClassifiedPushFailure {
  const status = statusCode(error);
  if (status === 400 || status === 404 || status === 410) {
    return {
      outcome: "PERMANENT_FAILURE",
      errorCode: `PUSH_SUBSCRIPTION_REJECTED_${status}`,
      removeSubscription: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      outcome: "RETRY",
      errorCode: `PUSH_AUTHORIZATION_FAILED_${status}`,
      removeSubscription: false,
    };
  }
  if (status === 429) {
    return {
      outcome: "RETRY",
      errorCode: "PUSH_RATE_LIMITED_429",
      removeSubscription: false,
    };
  }
  if (status !== null && status >= 500) {
    return {
      outcome: "RETRY",
      errorCode: `PUSH_PROVIDER_UNAVAILABLE_${status}`,
      removeSubscription: false,
    };
  }
  if (status !== null && status >= 400) {
    return {
      outcome: "PERMANENT_FAILURE",
      errorCode: `PUSH_REQUEST_REJECTED_${status}`,
      removeSubscription: false,
    };
  }
  return {
    outcome: "RETRY",
    errorCode: "PUSH_PROVIDER_REQUEST_FAILED",
    removeSubscription: false,
  };
}

export function buildPrivatePushPayload(
  deliveryId: string,
  severity: PushSeverity,
) {
  return JSON.stringify({
    title: severity === "CRITICAL" ? "Urgent work-queue alert" : "New work-queue alert",
    body: "Open Baker Street to review this secure task.",
    href: "/notifications",
    tag: `work-queue-${deliveryId}`,
  });
}

export function pushTtl(expiresAt: string | null, now = Date.now()) {
  const oneDay = 24 * 60 * 60;
  if (!expiresAt) return oneDay;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return oneDay;
  return Math.max(0, Math.min(oneDay, Math.floor((expires - now) / 1_000)));
}
