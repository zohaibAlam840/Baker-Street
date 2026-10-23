import { describe, expect, it } from "vitest";

import {
  type OperationalSnapshot,
  evaluateOperationalAlerts,
  readOperationalAlertConfig,
} from "./operationalAlerts";

const empty = (): OperationalSnapshot => ({
  active_authorizations_expired: 0,
  active_authorizations_expiring: 0,
  active_credentials_expired: 0,
  active_credentials_expiring: 0,
  communication_failures_24h: 0,
  overdue_communication_jobs: 0,
  failed_sign_ins_15m: 0,
  optimizer_bounded_24h: 0,
  push_failures_24h: 0,
});

describe("operational alerts", () => {
  it("is healthy when every aggregate is below its threshold", () => {
    const result = evaluateOperationalAlerts(empty(), readOperationalAlertConfig({}));
    expect(result).toEqual({ status: "ok", issues: [] });
  });

  it("makes expired records and failed-sign-in spikes critical", () => {
    const snapshot = empty();
    snapshot.active_authorizations_expired = 1;
    snapshot.failed_sign_ins_15m = 10;
    const result = evaluateOperationalAlerts(snapshot, readOperationalAlertConfig({}));
    expect(result.status).toBe("critical");
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "ACTIVE_AUTHORIZATIONS_EXPIRED",
      "FAILED_SIGN_IN_SPIKE",
    ]));
  });

  it("escalates a threshold when its volume doubles", () => {
    const config = readOperationalAlertConfig({ ALERT_COMMUNICATION_FAILURE_THRESHOLD: "3" });
    const snapshot = empty();
    snapshot.communication_failures_24h = 3;
    expect(evaluateOperationalAlerts(snapshot, config).status).toBe("warning");
    snapshot.communication_failures_24h = 6;
    expect(evaluateOperationalAlerts(snapshot, config).status).toBe("critical");
  });

  it("falls back from malformed threshold configuration", () => {
    const config = readOperationalAlertConfig({
      ALERT_EXPIRY_DAYS: "0",
      ALERT_FAILED_SIGN_IN_THRESHOLD: "not-a-number",
    });
    expect(config.expiryDays).toBe(45);
    expect(config.failedSignInThreshold).toBe(10);
  });

  it("returns aggregate-only issues without record identifiers", () => {
    const snapshot = empty();
    snapshot.active_credentials_expiring = 2;
    const serialized = JSON.stringify(
      evaluateOperationalAlerts(snapshot, readOperationalAlertConfig({})),
    );
    expect(serialized).not.toMatch(/patient_id|provider_id|email|name/i);
  });
});
