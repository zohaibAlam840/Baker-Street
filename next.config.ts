import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The dev-mode indicator sits in the bottom-left corner, which is where the
   * assistant launcher now lives — they overlap on every screen. It is absent
   * from a production build either way, so turning it off costs nothing and
   * stops a local demo looking broken.
   */
  devIndicators: false,
};

export default nextConfig;
