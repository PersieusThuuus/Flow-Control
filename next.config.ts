import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Hide the floating dev-tools indicator in development.
  devIndicators: false,
};

export default nextConfig;
