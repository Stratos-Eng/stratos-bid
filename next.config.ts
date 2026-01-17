import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Externalize packages that don't work well with webpack bundling
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'canvas'],

  // Empty turbopack config to silence Next.js 16 warning when webpack config is present
  turbopack: {},

  // Exclude services directory from webpack file watching
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/services/**', '**/node_modules/**'],
    };
    return config;
  },
};

export default nextConfig;
