import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "Baker Street Clinical Scheduling",
    short_name: "Baker Street",
    description: "Secure clinical scheduling and operations",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f7f9fa",
    theme_color: "#047857",
    orientation: "any",
    categories: ["medical", "productivity"],
    icons: [
      { src: "/icons/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
