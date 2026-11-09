/**
 * Next.js configuration for the Delhi NCR Heat Atlas.
 *
 * - Content pages (/, /findings, /methodology, /data, /learn, /about) are statically generated
 *   at build time from the web bundle in public/data, so search engines get complete HTML.
 * - /explore is the interactive WebGL dashboard: a client-only island (deck.gl + MapLibre),
 *   loaded with next/dynamic and ssr: false.
 * - NEXT_PUBLIC_BASE_PATH serves the site under a sub-path (empty on Vercel).
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: basePath || undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // The web bundle is pre-compressed (.gz) binary data the dashboard decodes itself: never let
  // the server transform it, and let browsers cache it (file names change with each export).
  async headers() {
    return [
      {
        source: "/data/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  images: { unoptimized: true },
};

export default nextConfig;
