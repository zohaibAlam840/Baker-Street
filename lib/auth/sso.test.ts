import { describe, expect, it } from "vitest";

import { readEnterpriseSsoConfig } from "./sso";

describe("enterprise SSO configuration", () => {
  it("is disabled by default", () => {
    expect(readEnterpriseSsoConfig({})).toBeNull();
  });

  it("accepts one provider selector", () => {
    expect(readEnterpriseSsoConfig({
      ENTERPRISE_SSO_ENABLED: "true",
      ENTERPRISE_SSO_PROVIDER_ID: "provider_12345678",
      ENTERPRISE_SSO_LABEL: "Clinic SSO",
    })).toEqual({ providerId: "provider_12345678", label: "Clinic SSO" });
    expect(readEnterpriseSsoConfig({
      ENTERPRISE_SSO_ENABLED: "true",
      ENTERPRISE_SSO_DOMAIN: "staff.example.org",
    })).toEqual({ domain: "staff.example.org", label: "Work SSO" });
  });

  it("rejects ambiguous and malformed selectors", () => {
    expect(() => readEnterpriseSsoConfig({ ENTERPRISE_SSO_ENABLED: "true" })).toThrow(/exactly one/);
    expect(() => readEnterpriseSsoConfig({
      ENTERPRISE_SSO_ENABLED: "true",
      ENTERPRISE_SSO_PROVIDER_ID: "provider_12345678",
      ENTERPRISE_SSO_DOMAIN: "staff.example.org",
    })).toThrow(/exactly one/);
    expect(() => readEnterpriseSsoConfig({
      ENTERPRISE_SSO_ENABLED: "true",
      ENTERPRISE_SSO_DOMAIN: "https://staff.example.org",
    })).toThrow(/DNS domain/);
  });
});
