import { describe, expect, it } from "vitest";

import { DeliveryConfigurationError, readDeliveryRuntimeConfig } from "./config";

const base = {
  COMMUNICATIONS_DELIVERY_ENABLED: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  COMMUNICATIONS_PUBLIC_BASE_URL: "https://scheduler.example.test",
};

describe("communication delivery configuration", () => {
  it("enables only channels with complete provider credentials", () => {
    const config = readDeliveryRuntimeConfig({
      ...base,
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "twilio-token",
      TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    });
    expect(config.channels).toEqual(["SMS"]);
    expect(config.twilio?.fromNumber).toBeNull();
    expect(config.sendGrid).toBeNull();
  });

  it("requires an explicit live-delivery environment gate", () => {
    expect(() =>
      readDeliveryRuntimeConfig({
        ...base,
        COMMUNICATIONS_DELIVERY_ENABLED: "false",
      }),
    ).toThrowError(expect.objectContaining<Partial<DeliveryConfigurationError>>({ code: "DELIVERY_DISABLED" }));
  });

  it("fails closed on a partial provider configuration", () => {
    expect(() =>
      readDeliveryRuntimeConfig({
        ...base,
        SENDGRID_FROM_EMAIL: "reminders@example.test",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryConfigurationError>>({
        code: "MISSING_DELIVERY_CONFIGURATION",
      }),
    );
  });

  it("rejects a non-HTTPS public callback URL", () => {
    expect(() =>
      readDeliveryRuntimeConfig({
        ...base,
        COMMUNICATIONS_PUBLIC_BASE_URL: "http://scheduler.example.test",
        SENDGRID_API_KEY: "sendgrid-key",
        SENDGRID_FROM_EMAIL: "reminders@example.test",
        SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "A".repeat(100),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryConfigurationError>>({ code: "INVALID_PUBLIC_BASE_URL" }),
    );
  });
});
