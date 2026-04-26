/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "mailparser"],
  },
  webpack: (config) => {
    // pdf-parse references a test file in its main entrypoint; ignore the fs probe.
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
    };
    return config;
  },
};

export default nextConfig;
