/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: true },
};

module.exports = nextConfig;
