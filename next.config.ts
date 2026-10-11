import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    ] }];
  },
};

export default nextConfig;
