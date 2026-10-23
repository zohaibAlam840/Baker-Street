import { describe, expect, it } from "vitest";

import { validateDeploymentEnvironment } from "./environment";

const valid = (): Record<string, string | undefined> => ({
  NEXT_PUBLIC_SUPABASE_URL: "https://clinic.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  NEXT_PUBLIC_SITE_URL: "https://staging.example.org",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "public-vapid",
  VAPID_PRIVATE_KEY: "private-vapid",
  VAPID_SUBJECT: "mailto:operations@example.org",
  SCHEDULING_TIMEZONE: "America/New_York",
  RELEASE_SHA: "0123456789abcdef",
  COMMUNICATIONS_DELIVERY_ENABLED: "false",
});

describe("deployment environment validation", () => {
  it("accepts a traceable record-only staging environment", () => {
    const result = validateDeploymentEnvironment(valid(), "staging");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects missing values and synthetic production data", () => {
    const result = validateDeploymentEnvironment(
      { USE_SYNTHETIC_DATA: "true" },
      "production",
    );
    expect(result.errors).toContain("NEXT_PUBLIC_SUPABASE_URL is required for production.");
    expect(result.errors).toContain(
      "USE_SYNTHETIC_DATA must be false or absent outside local development.",
    );
  });

  it("rejects unsafe origins, timezones, and public secret keys", () => {
    const env = valid();
    env.NEXT_PUBLIC_SUPABASE_URL = "http://clinic.supabase.co/path";
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_secret_do-not-expose";
    env.SCHEDULING_TIMEZONE = "Mars/Olympus";
    const result = validateDeploymentEnvironment(env, "staging");
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("NEXT_PUBLIC_SUPABASE_URL must be an HTTPS origin"),
      expect.stringContaining("public Supabase key"),
      expect.stringContaining("valid IANA timezone"),
    ]));
  });

  it("requires a complete provider when live communications are enabled", () => {
    const env = valid();
    env.COMMUNICATIONS_DELIVERY_ENABLED = "true";
    const result = validateDeploymentEnvironment(env, "production");
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("SUPABASE_SERVICE_ROLE_KEY"),
      expect.stringContaining("one complete Twilio or SendGrid"),
    ]));
  });

  it("requires the protected operational monitor in production", () => {
    const result = validateDeploymentEnvironment(valid(), "production");
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("SUPABASE_SERVICE_ROLE_KEY"),
      expect.stringContaining("CRON_SECRET must contain at least 16"),
    ]));
  });

  it("rejects malformed alert thresholds", () => {
    const env = valid();
    env.ALERT_FAILED_SIGN_IN_THRESHOLD = "0";
    expect(validateDeploymentEnvironment(env, "staging").errors).toContain(
      "ALERT_FAILED_SIGN_IN_THRESHOLD must be an integer between 1 and 10000.",
    );
  });

  it("rejects unsafe push worker bounds", () => {
    const env = valid();
    env.PUSH_DELIVERY_BATCH_SIZE = "101";
    env.PUSH_DELIVERY_CONCURRENCY = "0";
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual(expect.arrayContaining([
      "PUSH_DELIVERY_BATCH_SIZE must be an integer between 1 and 100.",
      "PUSH_DELIVERY_CONCURRENCY must be an integer between 1 and 10.",
    ]));
  });

  it("accepts a complete SendGrid live-delivery configuration", () => {
    const env = valid();
    Object.assign(env, {
      COMMUNICATIONS_DELIVERY_ENABLED: "true",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      CRON_SECRET: "cron-secret",
      COMMUNICATIONS_PUBLIC_BASE_URL: "https://staging.example.org",
      SENDGRID_API_KEY: "sendgrid-key",
      SENDGRID_FROM_EMAIL: "messages@example.org",
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "verification-key",
    });
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual([]);
  });

  it("validates an optional authenticated CP-SAT service", () => {
    const env = valid();
    Object.assign(env, {
      CP_SAT_SOLVER_URL: "https://solver.example.org",
      CP_SAT_SOLVER_SECRET: "a-secret-with-more-than-24-characters",
      CP_SAT_REQUIRED: "true",
      CP_SAT_MAX_CANDIDATES: "4000",
      CP_SAT_TIME_LIMIT_SECONDS: "8.5",
    });
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual([]);
  });

  it("rejects partial or insecure CP-SAT configuration", () => {
    const env = valid();
    Object.assign(env, {
      CP_SAT_SOLVER_URL: "http://solver.example.org/path",
      CP_SAT_REQUIRED: "true",
      CP_SAT_TIMEOUT_MS: "100",
    });
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual(expect.arrayContaining([
      expect.stringContaining("CP_SAT_SOLVER_URL must be an HTTPS origin"),
      expect.stringContaining("CP_SAT_SOLVER_SECRET must contain at least 24"),
      expect.stringContaining("CP_SAT_TIMEOUT_MS must be an integer between 500 and 30000"),
    ]));
  });

  it("validates mobile store link identities only when enabled", () => {
    const env = valid();
    Object.assign(env, {
      MOBILE_ANDROID_APP_LINKS_ENABLED: "true",
      MOBILE_ANDROID_PACKAGE_ID: "org.example.bakerstreet",
      MOBILE_ANDROID_SHA256_CERT_FINGERPRINTS: Array.from(
        { length: 32 },
        (_, index) => index.toString(16).padStart(2, "0"),
      ).join(":"),
      MOBILE_IOS_UNIVERSAL_LINKS_ENABLED: "true",
      MOBILE_IOS_TEAM_ID: "A1B2C3D4E5",
      MOBILE_IOS_BUNDLE_ID: "org.example.bakerstreet",
    });
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual([]);

    env.MOBILE_IOS_TEAM_ID = "pending";
    expect(validateDeploymentEnvironment(env, "staging").errors).toContain(
      "MOBILE_IOS_TEAM_ID must contain the 10-character Apple Team ID.",
    );
  });

  it("validates enterprise SSO selectors", () => {
    const env = valid();
    Object.assign(env, {
      ENTERPRISE_SSO_ENABLED: "true",
      ENTERPRISE_SSO_DOMAIN: "staff.example.org",
      ENTERPRISE_SSO_LABEL: "Clinic SSO",
    });
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual([]);
    env.ENTERPRISE_SSO_PROVIDER_ID = "provider_12345678";
    expect(validateDeploymentEnvironment(env, "staging").errors).toContain(
      "Configure exactly one ENTERPRISE_SSO_PROVIDER_ID or ENTERPRISE_SSO_DOMAIN.",
    );
  });

  it("validates optional EHR FHIR configuration", () => {
    const env = valid();
    Object.assign(env, {
      EHR_INTEGRATION_ENABLED: "true",
      EHR_FHIR_BASE_URL: "https://ehr.example.org/fhir/r4",
      EHR_FHIR_AUTH_MODE: "BEARER",
      EHR_FHIR_BEARER_TOKEN: "a-token-with-at-least-16-characters",
    });
    expect(validateDeploymentEnvironment(env, "staging").errors).toEqual([]);
    env.EHR_FHIR_BASE_URL = "http://ehr.example.org/fhir";
    expect(validateDeploymentEnvironment(env, "staging").errors).toContain(
      "EHR_FHIR_BASE_URL must be an HTTPS URL without credentials, query, or fragment.",
    );
  });
});
