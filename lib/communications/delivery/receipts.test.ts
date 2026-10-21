import twilio from "twilio";
import { describe, expect, it } from "vitest";

import {
  canonicalWebhookUrl,
  mapTwilioOptOutReceipt,
  mapTwilioStatusReceipt,
  parseFormBody,
  parseSendGridReceipts,
  verifySendGridSignature,
  verifyTwilioForm,
} from "./receipts";

const receiptToken = "123e4567-e89b-42d3-a456-426614174000";
const messageSid = `SM${"a".repeat(32)}`;

describe("Twilio communication receipts", () => {
  it("validates the signature against the configured public URL", () => {
    const requestUrl = `http://localhost:3000/api/communications/webhooks/twilio?token=${receiptToken}`;
    const publicBaseUrl = "https://scheduler.example.test";
    const rawBody = `MessageSid=${messageSid}&MessageStatus=delivered`;
    const canonical = canonicalWebhookUrl(requestUrl, publicBaseUrl);
    const signature = twilio.getExpectedTwilioSignature(
      "auth-token",
      canonical,
      parseFormBody(rawBody),
    );
    expect(
      verifyTwilioForm({
        authToken: "auth-token",
        signature,
        requestUrl,
        publicBaseUrl,
        rawBody,
      }),
    ).not.toBeNull();
    expect(
      verifyTwilioForm({
        authToken: "wrong-token",
        signature,
        requestUrl,
        publicBaseUrl,
        rawBody,
      }),
    ).toBeNull();
  });

  it("maps terminal delivery and provider opt-out statuses", () => {
    expect(
      mapTwilioStatusReceipt(
        { MessageSid: messageSid, MessageStatus: "delivered" },
        receiptToken,
        new Date("2026-10-21T10:00:00Z"),
      ),
    ).toMatchObject({ receiptType: "DELIVERED", metadata: { provider_status: "DELIVERED" } });
    expect(
      mapTwilioStatusReceipt(
        { MessageSid: messageSid, MessageStatus: "failed", ErrorCode: "21610" },
        receiptToken,
      ),
    ).toMatchObject({ receiptType: "OPT_OUT" });
  });

  it("recognizes only Twilio Advanced Opt-Out STOP events", () => {
    expect(
      mapTwilioOptOutReceipt({
        MessageSid: messageSid,
        From: "+15551234567",
        OptOutType: "STOP",
      }),
    ).toMatchObject({ destination: "+15551234567" });
    expect(
      mapTwilioOptOutReceipt({
        MessageSid: messageSid,
        From: "+15551234567",
        OptOutType: "START",
      }),
    ).toBeNull();
  });
});

describe("SendGrid communication receipts", () => {
  it("verifies a signed raw event body", () => {
    const publicKey =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
    const signature =
      "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=";
    const rawBody =
      '[{"email":"hello@world.com","event":"dropped","reason":"Bounced Address","sg_event_id":"ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA","sg_message_id":"LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0","smtp-id":"<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>","timestamp":1600112492}]\r\n';
    expect(
      verifySendGridSignature({
        publicKey,
        signature,
        timestamp: "1600112502",
        rawBody,
      }),
    ).toBe(true);
    expect(
      verifySendGridSignature({
        publicKey,
        signature,
        timestamp: "1600112502",
        rawBody: `${rawBody} `,
      }),
    ).toBe(false);
  });

  it("maps delivery, deferral, hard bounce, complaint, and opt-out events", () => {
    const payload = JSON.stringify([
      {
        event: "processed",
        sg_event_id: "processed-1",
        timestamp: 1792576800,
        custom_args: { communication_receipt_token: receiptToken },
      },
      {
        event: "deferred",
        sg_event_id: "deferred-1",
        timestamp: 1792576801,
        custom_args: { communication_receipt_token: receiptToken },
      },
      {
        event: "bounce",
        type: "bounce",
        sg_event_id: "bounce-1",
        timestamp: 1792576802,
        custom_args: { communication_receipt_token: receiptToken },
      },
      {
        event: "spamreport",
        sg_event_id: "complaint-1",
        timestamp: 1792576803,
        custom_args: { communication_receipt_token: receiptToken },
      },
      {
        event: "unsubscribe",
        sg_event_id: "unsubscribe-1",
        timestamp: 1792576804,
        custom_args: { communication_receipt_token: receiptToken },
      },
      {
        event: "open",
        sg_event_id: "ignored-1",
        timestamp: 1792576805,
        custom_args: { communication_receipt_token: receiptToken },
      },
    ]);
    expect(parseSendGridReceipts(payload).map((receipt) => receipt.receiptType)).toEqual([
      "ACCEPTED",
      "ACCEPTED",
      "BOUNCED",
      "COMPLAINT",
      "OPT_OUT",
    ]);
  });

  it("ignores account-wide events that do not carry this app's opaque token", () => {
    expect(
      parseSendGridReceipts(
        JSON.stringify([{ event: "delivered", sg_event_id: "other-1", timestamp: 1792576800 }]),
      ),
    ).toEqual([]);
  });
});

