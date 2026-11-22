import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The CSV is read with fs at runtime; make sure it ships with every server function.
  outputFileTracingIncludes: { "/**": ["./data/*.csv"] },
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
};

export default nextConfig;
