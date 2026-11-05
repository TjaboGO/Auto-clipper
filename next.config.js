/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We shell out to ffmpeg/ffprobe/python at runtime, so this app is not
  // meant to be deployed to edge/serverless targets - it needs a normal
  // long-running Node server (see README, Dockerfile).
  output: 'standalone',
};

module.exports = nextConfig;
