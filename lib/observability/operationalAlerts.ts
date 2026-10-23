export type OperationalAlertSeverity = "warning" | "critical";
export type OperationalAlertStatus = "ok" | OperationalAlertSeverity;

export interface OperationalSnapshot {
  active_authorizations_expired: number;
  active_authorizations_expiring: number;
  active_credentials_expired: number;
  active_credentials_expiring: number;
  communication_failures_24h: number;
  overdue_communication_jobs: number;
  failed_sign_ins_15m: number;
  optimizer_bounded_24h: number;
  push_failures_24h: number;
}

export interface OperationalAlertConfig {
  expiryDays: number;
  communicationFailureThreshold: number;
  communicationBacklogThreshold: number;
  failedSignInThreshold: number;
  optimizerBoundedThreshold: number;
  pushFailureThreshold: number;
}

export interface OperationalIssue {
  code: string;
  severity: OperationalAlertSeverity;
  count: number;
  targetRole: "AUTHORIZATION" | "ADMIN" | "SCHEDULER" | "OPERATIONS";
  title: string;
  body: string;
  href: string;
}

const DEFAULTS: OperationalAlertConfig = {
  expiryDays: 45,
  communicationFailureThreshold: 5,
  communicationBacklogThreshold: 20,
  failedSignInThreshold: 10,
  optimizerBoundedThreshold: 10,
  pushFailureThreshold: 5,
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000
    ? parsed
    : fallback;
}

export function readOperationalAlertConfig(
  env: Readonly<Record<string, string | undefined>>,
): OperationalAlertConfig {
  return {
    expiryDays: positiveInteger(env.ALERT_EXPIRY_DAYS, DEFAULTS.expiryDays),
    communicationFailureThreshold: positiveInteger(
      env.ALERT_COMMUNICATION_FAILURE_THRESHOLD,
      DEFAULTS.communicationFailureThreshold,
    ),
    communicationBacklogThreshold: positiveInteger(
      env.ALERT_COMMUNICATION_BACKLOG_THRESHOLD,
      DEFAULTS.communicationBacklogThreshold,
    ),
    failedSignInThreshold: positiveInteger(
      env.ALERT_FAILED_SIGN_IN_THRESHOLD,
      DEFAULTS.failedSignInThreshold,
    ),
    optimizerBoundedThreshold: positiveInteger(
      env.ALERT_OPTIMIZER_BOUNDED_THRESHOLD,
      DEFAULTS.optimizerBoundedThreshold,
    ),
    pushFailureThreshold: positiveInteger(
      env.ALERT_PUSH_FAILURE_THRESHOLD,
      DEFAULTS.pushFailureThreshold,
    ),
  };
}

function thresholdSeverity(count: number, threshold: number): OperationalAlertSeverity {
  return count >= threshold * 2 ? "critical" : "warning";
}

export function evaluateOperationalAlerts(
  snapshot: OperationalSnapshot,
  config: OperationalAlertConfig,
) {
  const issues: OperationalIssue[] = [];

  if (snapshot.active_authorizations_expired > 0) {
    issues.push({
      code: "ACTIVE_AUTHORIZATIONS_EXPIRED",
      severity: "critical",
      count: snapshot.active_authorizations_expired,
      targetRole: "AUTHORIZATION",
      title: "Active authorizations have expired",
      body: `${snapshot.active_authorizations_expired} active authorization record(s) require immediate review.`,
      href: "/authorizations",
    });
  }
  if (snapshot.active_authorizations_expiring > 0) {
    issues.push({
      code: "ACTIVE_AUTHORIZATIONS_EXPIRING",
      severity: "warning",
      count: snapshot.active_authorizations_expiring,
      targetRole: "AUTHORIZATION",
      title: "Authorizations are nearing expiration",
      body: `${snapshot.active_authorizations_expiring} active authorization record(s) expire within ${config.expiryDays} days.`,
      href: "/authorizations",
    });
  }
  if (snapshot.active_credentials_expired > 0) {
    issues.push({
      code: "ACTIVE_CREDENTIALS_EXPIRED",
      severity: "critical",
      count: snapshot.active_credentials_expired,
      targetRole: "ADMIN",
      title: "Active credentials have expired",
      body: `${snapshot.active_credentials_expired} active credential record(s) require immediate review.`,
      href: "/providers",
    });
  }
  if (snapshot.active_credentials_expiring > 0) {
    issues.push({
      code: "ACTIVE_CREDENTIALS_EXPIRING",
      severity: "warning",
      count: snapshot.active_credentials_expiring,
      targetRole: "ADMIN",
      title: "Credentials are nearing expiration",
      body: `${snapshot.active_credentials_expiring} active credential record(s) expire within ${config.expiryDays} days.`,
      href: "/providers",
    });
  }
  if (snapshot.failed_sign_ins_15m >= config.failedSignInThreshold) {
    issues.push({
      code: "FAILED_SIGN_IN_SPIKE",
      severity: "critical",
      count: snapshot.failed_sign_ins_15m,
      targetRole: "ADMIN",
      title: "Failed sign-in spike detected",
      body: `${snapshot.failed_sign_ins_15m} failed sign-in attempts were recorded in 15 minutes.`,
      href: "/audit",
    });
  }
  if (snapshot.communication_failures_24h >= config.communicationFailureThreshold) {
    issues.push({
      code: "COMMUNICATION_FAILURE_THRESHOLD",
      severity: thresholdSeverity(
        snapshot.communication_failures_24h,
        config.communicationFailureThreshold,
      ),
      count: snapshot.communication_failures_24h,
      targetRole: "SCHEDULER",
      title: "Communication delivery failures need review",
      body: `${snapshot.communication_failures_24h} communication job(s) failed during the last 24 hours.`,
      href: "/communications",
    });
  }
  if (snapshot.overdue_communication_jobs >= config.communicationBacklogThreshold) {
    issues.push({
      code: "COMMUNICATION_BACKLOG_THRESHOLD",
      severity: thresholdSeverity(
        snapshot.overdue_communication_jobs,
        config.communicationBacklogThreshold,
      ),
      count: snapshot.overdue_communication_jobs,
      targetRole: "SCHEDULER",
      title: "Communication queue is delayed",
      body: `${snapshot.overdue_communication_jobs} due communication job(s) are waiting to be processed.`,
      href: "/communications",
    });
  }
  if (snapshot.optimizer_bounded_24h >= config.optimizerBoundedThreshold) {
    issues.push({
      code: "OPTIMIZER_BOUNDED_THRESHOLD",
      severity: thresholdSeverity(
        snapshot.optimizer_bounded_24h,
        config.optimizerBoundedThreshold,
      ),
      count: snapshot.optimizer_bounded_24h,
      targetRole: "OPERATIONS",
      title: "Optimizer safety limits are frequent",
      body: `${snapshot.optimizer_bounded_24h} optimizer decision(s) reached a safety limit during the last 24 hours.`,
      href: "/capacity",
    });
  }
  if (snapshot.push_failures_24h >= config.pushFailureThreshold) {
    issues.push({
      code: "PUSH_FAILURE_THRESHOLD",
      severity: thresholdSeverity(snapshot.push_failures_24h, config.pushFailureThreshold),
      count: snapshot.push_failures_24h,
      targetRole: "ADMIN",
      title: "Push delivery failures need review",
      body: `${snapshot.push_failures_24h} push delivery attempt(s) failed during the last 24 hours.`,
      href: "/settings",
    });
  }

  issues.sort((left, right) => (
    left.severity === right.severity ? left.code.localeCompare(right.code) : left.severity === "critical" ? -1 : 1
  ));
  const status: OperationalAlertStatus = issues.some(({ severity }) => severity === "critical")
    ? "critical"
    : issues.length > 0
      ? "warning"
      : "ok";
  return { status, issues };
}
