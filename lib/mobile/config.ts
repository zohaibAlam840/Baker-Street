export interface MobileAssociationConfig {
  siteOrigin: string | null;
  android: {
    enabled: boolean;
    packageId: string | null;
    certificateFingerprints: string[];
  };
  ios: {
    enabled: boolean;
    teamId: string | null;
    bundleId: string | null;
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function value(env: Environment, name: string) {
  return env[name]?.trim() ?? "";
}

function flag(env: Environment, name: string) {
  const candidate = value(env, name).toLowerCase();
  if (!candidate || candidate === "false") return false;
  if (candidate === "true") return true;
  throw new Error(`${name} must be true or false.`);
}

function httpsOrigin(raw: string) {
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function readMobileAssociationConfig(
  env: Environment = process.env,
): MobileAssociationConfig {
  const androidEnabled = flag(env, "MOBILE_ANDROID_APP_LINKS_ENABLED");
  const iosEnabled = flag(env, "MOBILE_IOS_UNIVERSAL_LINKS_ENABLED");
  const siteOriginRaw = value(env, "NEXT_PUBLIC_SITE_URL");
  const siteOrigin = siteOriginRaw ? httpsOrigin(siteOriginRaw) : null;
  const packageId = value(env, "MOBILE_ANDROID_PACKAGE_ID") || null;
  const teamId = value(env, "MOBILE_IOS_TEAM_ID").toUpperCase() || null;
  const bundleId = value(env, "MOBILE_IOS_BUNDLE_ID") || null;
  const certificateFingerprints = value(
    env,
    "MOBILE_ANDROID_SHA256_CERT_FINGERPRINTS",
  )
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  if ((androidEnabled || iosEnabled) && !siteOrigin) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must be an HTTPS origin when mobile link association is enabled.",
    );
  }
  if (androidEnabled) {
    if (!packageId || !PACKAGE_ID.test(packageId)) {
      throw new Error(
        "MOBILE_ANDROID_PACKAGE_ID must be a valid reverse-domain Android package ID.",
      );
    }
    if (
      certificateFingerprints.length === 0
      || certificateFingerprints.some((entry) => !FINGERPRINT.test(entry))
    ) {
      throw new Error(
        "MOBILE_ANDROID_SHA256_CERT_FINGERPRINTS must contain comma-separated SHA-256 signing fingerprints.",
      );
    }
  }
  if (iosEnabled) {
    if (!teamId || !TEAM_ID.test(teamId)) {
      throw new Error("MOBILE_IOS_TEAM_ID must contain the 10-character Apple Team ID.");
    }
    if (!bundleId || !BUNDLE_ID.test(bundleId)) {
      throw new Error(
        "MOBILE_IOS_BUNDLE_ID must be a valid reverse-domain Apple bundle ID.",
      );
    }
  }

  return {
    siteOrigin,
    android: { enabled: androidEnabled, packageId, certificateFingerprints },
    ios: { enabled: iosEnabled, teamId, bundleId },
  };
}

