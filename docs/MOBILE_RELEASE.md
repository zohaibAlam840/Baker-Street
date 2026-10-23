# Mobile installation and store release

The production-ready mobile surface is the installable PWA. It uses the same
server-rendered application, Supabase session, RLS policies, and scheduling
transactions as desktop. The service worker caches only the public offline
screen and app artwork; it never caches patient pages, API responses, or writes.
Users can install it from **Settings → Install on this device**.

## What is implemented

- a complete web-app manifest with 192 px, 512 px, maskable, SVG, and Apple
  touch artwork;
- a safe offline fallback and automatic service-worker updates;
- push notification artwork and the existing end-to-end web-push worker;
- Android Digital Asset Links at `/.well-known/assetlinks.json`;
- Apple App Site Association at
  `/.well-known/apple-app-site-association`; and
- strict release configuration validation through
  `npm run verify:mobile-release` and the normal deployment verifier.

The association endpoints return `404` while their platform is disabled and
`503` for invalid partial configuration. They never publish placeholder package
IDs or signing fingerprints.

## Why there is no committed Capacitor wrapper

This application relies on Next.js server routes and authenticated server
rendering, so it cannot be copied into a static native web bundle without
rebuilding the application around a separate API. Capacitor's remote
`server.url` option is documented for live reload and explicitly not for
production. A production wrapper built that way would be a misleading release
artifact and could weaken navigation and authentication boundaries.

For Android, a Trusted Web Activity can package the deployed PWA after the
client's final domain, package ID, Play signing fingerprint, and store account
exist. An iOS wrapper or dedicated native client requires the client's Apple
Team ID, bundle ID, signing profile, associated-domain entitlement, and App
Store account. Store review and signed binaries belong to those client-owned
accounts and cannot be safely generated from placeholder identities.

## Client inputs required for store binaries

1. Final production HTTPS origin and privacy/support URLs.
2. Approved Android package ID and Apple bundle ID.
3. Google Play Console and Apple Developer/App Store Connect access.
4. Play App Signing SHA-256 certificate fingerprint(s).
5. Apple Team ID, signing certificates, and provisioning profiles.
6. App name, category, age rating, screenshots, descriptions, and privacy
   disclosures approved for the stores.
7. A decision on whether native-store distribution is necessary in addition to
   the PWA, plus device-management requirements for clinical staff.

## Enabling verified links

Set only the platform being released:

```text
MOBILE_ANDROID_APP_LINKS_ENABLED=true
MOBILE_ANDROID_PACKAGE_ID=org.example.bakerstreet
MOBILE_ANDROID_SHA256_CERT_FINGERPRINTS=AA:...:FF

MOBILE_IOS_UNIVERSAL_LINKS_ENABLED=true
MOBILE_IOS_TEAM_ID=A1B2C3D4E5
MOBILE_IOS_BUNDLE_ID=org.example.bakerstreet
```

Then run:

```powershell
npm.cmd run verify:mobile-release
```

After deployment, fetch both association URLs from the production domain and
verify them on physical devices before shipping any store build. Do not enable
an association for an unsigned, test, or placeholder identity.

