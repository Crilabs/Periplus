import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
    // PDF uploads on the source page: the action itself refuses files over 100 MB. The limit covers the raw multipart
    // body (boundaries, part headers, fields), so it sits 1 MB higher; the proxy buffers the same body.
    serverActions: { bodySizeLimit: "101mb" },
    proxyClientMaxBodySize: "101mb",
  },
  output: "standalone",
  // The rendering browser runs only in the worker; never bundle it into the web server.
  serverExternalPackages: ["playwright", "playwright-core"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
