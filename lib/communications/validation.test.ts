import { describe, expect, it } from "vitest";

import {
  isCommunicationChannel,
  isIanaTimeZone,
  normalizeClock,
  normalizeEmail,
  normalizeLanguageTag,
  normalizePhone,
  validQuietHours,
} from "./validation";

describe("communication input validation", () => {
  it("normalizes email without accepting malformed addresses", () => {
    expect(normalizeEmail(" Guardian@Example.COM ")).toBe("guardian@example.com");
    expect(normalizeEmail("guardian.example.com")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });

  it("normalizes North American and explicit international phone numbers", () => {
    expect(normalizePhone("(212) 555-0100")).toBe("+12125550100");
    expect(normalizePhone("1-212-555-0100")).toBe("+12125550100");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("555-0100")).toBeNull();
  });

  it("requires real, distinct quiet-hour clock values", () => {
    expect(normalizeClock("22:00")).toBe("22:00");
    expect(normalizeClock("24:00")).toBeNull();
    expect(validQuietHours("21:30", "07:00")).toBe(true);
    expect(validQuietHours("08:00", "08:00")).toBe(false);
  });

  it("validates channels, timezones, and language tags", () => {
    expect(isCommunicationChannel("SMS")).toBe(true);
    expect(isCommunicationChannel("PHONE")).toBe(false);
    expect(isIanaTimeZone("America/New_York")).toBe(true);
    expect(isIanaTimeZone("Mars/Olympus")).toBe(false);
    expect(normalizeLanguageTag("en-us")).toBe("en-US");
    expect(normalizeLanguageTag("not_a_language")) .toBeNull();
  });
});
