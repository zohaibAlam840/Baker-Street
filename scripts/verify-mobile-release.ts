import { readMobileAssociationConfig } from "../lib/mobile/config";

try {
  const config = readMobileAssociationConfig(process.env);
  if (!config.android.enabled && !config.ios.enabled) {
    throw new Error("Enable at least one mobile association before a store release.");
  }
  console.log(JSON.stringify({
    ok: true,
    origin: config.siteOrigin,
    android: config.android.enabled,
    ios: config.ios.enabled,
    association_paths: [
      config.android.enabled ? "/.well-known/assetlinks.json" : null,
      config.ios.enabled ? "/.well-known/apple-app-site-association" : null,
    ].filter(Boolean),
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Mobile release configuration is invalid.");
  process.exit(1);
}

