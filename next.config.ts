import type { NextConfig } from "next";

function contentSecurityPolicy() {
  const connectSources = ["'self'"];
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (configuredUrl) {
    try {
      const supabase = new URL(configuredUrl);
      connectSources.push(supabase.origin);
      if (supabase.protocol === "https:") connectSources.push(`wss://${supabase.host}`);
    } catch {
      // Environment verification reports an invalid URL with a clearer error.
    }
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'none'",
    "frame-src 'none'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  /**
   * The dev-mode indicator sits in the bottom-left corner, which is where the
   * assistant launcher now lives — they overlap on every screen. It is absent
   * from a production build either way, so turning it off costs nothing and
   * stops a local demo looking broken.
   */
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "Content-Security-Policy", value: contentSecurityPolicy() },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    ] }];
  },
};

export default nextConfig;
