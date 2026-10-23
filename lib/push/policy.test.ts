import { describe, expect, it } from "vitest";

import { buildPrivatePushPayload, classifyPushFailure, pushTtl } from "./policy";

describe("push delivery policy", () => {
  it("builds a generic authenticated-app payload without notification content", () => {
    const payload = buildPrivatePushPayload("delivery-id", "CRITICAL");
    expect(JSON.parse(payload)).toEqual({
      title: "Urgent work-queue alert",
      body: "Open Baker Street to review this secure task.",
      href: "/notifications",
      tag: "work-queue-delivery-id",
    });
    expect(payload).not.toMatch(/patient|diagnosis|authorization|appointment/i);
  });

  it("removes subscriptions rejected as missing, expired, or invalid", () => {
    for (const statusCode of [400, 404, 410]) {
      expect(classifyPushFailure({ statusCode })).toMatchObject({
        outcome: "PERMANENT_FAILURE",
        removeSubscription: true,
      });
    }
  });

  it("retries authorization, rate-limit, provider, and network failures", () => {
    for (const error of [
      { statusCode: 401 },
      { statusCode: 403 },
      { statusCode: 429 },
      { statusCode: 503 },
      new Error("network unavailable"),
    ]) {
      expect(classifyPushFailure(error)).toMatchObject({
        outcome: "RETRY",
        removeSubscription: false,
      });
    }
  });

  it("caps provider retention at one day and respects earlier expiry", () => {
    const now = Date.parse("2026-10-23T00:00:00.000Z");
    expect(pushTtl(null, now)).toBe(86_400);
    expect(pushTtl("2026-10-23T00:05:00.000Z", now)).toBe(300);
    expect(pushTtl("2026-10-25T00:00:00.000Z", now)).toBe(86_400);
    expect(pushTtl("2026-10-22T23:59:00.000Z", now)).toBe(0);
  });
});
