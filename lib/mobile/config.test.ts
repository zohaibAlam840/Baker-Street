import { describe, expect, it } from "vitest";

import { buildAndroidAssetLinks, buildAppleAppSiteAssociation } from "./associations";
import { readMobileAssociationConfig } from "./config";

const fingerprint = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, "0")).join(":");

describe("mobile association configuration", () => {
  it("is disabled by default without requiring release identities", () => {
    expect(readMobileAssociationConfig({})).toMatchObject({
      siteOrigin: null,
      android: { enabled: false },
      ios: { enabled: false },
    });
  });

  it("builds Android and Apple association documents from validated identities", () => {
    const config = readMobileAssociationConfig({
      NEXT_PUBLIC_SITE_URL: "https://schedule.example.org",
      MOBILE_ANDROID_APP_LINKS_ENABLED: "true",
      MOBILE_ANDROID_PACKAGE_ID: "org.example.bakerstreet",
      MOBILE_ANDROID_SHA256_CERT_FINGERPRINTS: fingerprint,
      MOBILE_IOS_UNIVERSAL_LINKS_ENABLED: "true",
      MOBILE_IOS_TEAM_ID: "A1B2C3D4E5",
      MOBILE_IOS_BUNDLE_ID: "org.example.bakerstreet",
    });

    expect(buildAndroidAssetLinks(config)?.[0].target).toEqual({
      namespace: "android_app",
      package_name: "org.example.bakerstreet",
      sha256_cert_fingerprints: [fingerprint.toUpperCase()],
    });
    expect(buildAppleAppSiteAssociation(config)?.applinks.details[0].appID)
      .toBe("A1B2C3D4E5.org.example.bakerstreet");
  });

  it("rejects partial or malformed release identities", () => {
    expect(() => readMobileAssociationConfig({
      NEXT_PUBLIC_SITE_URL: "http://schedule.example.org",
      MOBILE_ANDROID_APP_LINKS_ENABLED: "true",
    })).toThrow("NEXT_PUBLIC_SITE_URL must be an HTTPS origin");

    expect(() => readMobileAssociationConfig({
      NEXT_PUBLIC_SITE_URL: "https://schedule.example.org",
      MOBILE_ANDROID_APP_LINKS_ENABLED: "true",
      MOBILE_ANDROID_PACKAGE_ID: "not a package",
      MOBILE_ANDROID_SHA256_CERT_FINGERPRINTS: "AA:BB",
    })).toThrow("MOBILE_ANDROID_PACKAGE_ID");

    expect(() => readMobileAssociationConfig({
      NEXT_PUBLIC_SITE_URL: "https://schedule.example.org",
      MOBILE_IOS_UNIVERSAL_LINKS_ENABLED: "true",
      MOBILE_IOS_TEAM_ID: "short",
      MOBILE_IOS_BUNDLE_ID: "org.example.app",
    })).toThrow("MOBILE_IOS_TEAM_ID");
  });
});

