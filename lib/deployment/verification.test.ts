import { describe, expect, it } from "vitest";

import {
  REQUIRED_SCHEMA_VERSION,
  healthErrors,
  protectedRedirectErrors,
  securityHeaderErrors,
} from "./verification";

const secureHeaders = () => new Headers({
  "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-permitted-cross-domain-policies": "none",
});

describe("deployment verification", () => {
  it("accepts a healthy expected release", () => {
    expect(healthErrors(200, {
      status: "ok",
      auth: "available",
      database: "available",
      configuration: "available",
      schema_version: REQUIRED_SCHEMA_VERSION,
      release: "0123456789ab",
    }, "0123456789abcdef")).toEqual([]);
  });

  it("reports schema, dependency, and release mismatches", () => {
    expect(healthErrors(503, {
      status: "degraded",
      auth: "unavailable",
      database: "degraded",
      configuration: "degraded",
      schema_version: "old",
      release: "different123",
    }, "0123456789abcdef")).toHaveLength(7);
  });

  it("requires the complete browser security boundary", () => {
    expect(securityHeaderErrors(secureHeaders(), true)).toEqual([]);
    const weak = secureHeaders();
    weak.delete("content-security-policy");
    weak.set("x-powered-by", "Next.js");
    expect(securityHeaderErrors(weak, true)).toEqual(expect.arrayContaining([
      expect.stringContaining("Content-Security-Policy"),
      expect.stringContaining("x-powered-by"),
    ]));
  });

  it("requires anonymous protected pages to redirect to same-origin login", () => {
    const base = new URL("https://staging.example.org");
    expect(protectedRedirectErrors(base, 307, "/login")).toEqual([]);
    expect(protectedRedirectErrors(
      base,
      200,
      null,
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/login"/>',
    )).toEqual([]);
    expect(protectedRedirectErrors(base, 302, "https://evil.example/login")).toHaveLength(2);
  });
});
