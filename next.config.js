/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["pg", "@node-rs/argon2"],
  eslint: { ignoreDuringBuilds: true },
};

module.exports = nextConfig;
