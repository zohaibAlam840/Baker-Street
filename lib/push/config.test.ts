import { describe, expect, it } from "vitest";

import { PushDeliveryConfigurationError, readPushDeliveryConfig } from "./config";

const valid = {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "public-key",
  VAPID_PRIVATE_KEY: "private-key",
  VAPID_SUBJECT: "mailto:operations@example.org",
  VERCEL_REQUEST_ID: "request-123",
};

describe("push delivery configuration", () => {
  it("uses bounded defaults and an invocation-scoped worker ID", () => {
    expect(readPushDeliveryConfig(valid)).toMatchObject({
      batchSize: 50,
      concurrency: 5,
      workerId: "push-request-123",
    });
  });

  it("accepts explicit safe worker bounds", () => {
    expect(readPushDeliveryConfig({
      ...valid,
      PUSH_DELIVERY_BATCH_SIZE: "25",
      PUSH_DELIVERY_CONCURRENCY: "3",
    })).toMatchObject({ batchSize: 25, concurrency: 3 });
  });

  it("fails closed when VAPID configuration is missing", () => {
    expect(() => readPushDeliveryConfig({}))
      .toThrowError(expect.objectContaining<Partial<PushDeliveryConfigurationError>>({
        code: "PUSH_NOT_CONFIGURED",
      }));
  });

  it("rejects invalid subjects and unsafe bounds", () => {
    expect(() => readPushDeliveryConfig({ ...valid, VAPID_SUBJECT: "operations" }))
      .toThrowError(expect.objectContaining<Partial<PushDeliveryConfigurationError>>({
        code: "INVALID_VAPID_SUBJECT",
      }));
    expect(() => readPushDeliveryConfig({ ...valid, PUSH_DELIVERY_CONCURRENCY: "11" }))
      .toThrowError(expect.objectContaining<Partial<PushDeliveryConfigurationError>>({
        code: "INVALID_PUSH_CONCURRENCY",
      }));
  });
});
