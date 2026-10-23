import type { MobileAssociationConfig } from "./config";

export function buildAndroidAssetLinks(config: MobileAssociationConfig) {
  if (!config.android.enabled || !config.android.packageId) return null;
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: config.android.packageId,
      sha256_cert_fingerprints: config.android.certificateFingerprints,
    },
  }];
}

export function buildAppleAppSiteAssociation(config: MobileAssociationConfig) {
  if (!config.ios.enabled || !config.ios.teamId || !config.ios.bundleId) return null;
  return {
    applinks: {
      apps: [],
      details: [{
        appID: `${config.ios.teamId}.${config.ios.bundleId}`,
        paths: ["/*"],
      }],
    },
  };
}

