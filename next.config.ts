import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Hide the floating dev-tools indicator in development: it overlapped the
  // sidebar footer in the preview environment.
  devIndicators: false,
};

export default nextConfig;
