import type { NextConfig } from "next";

// Reaching a local dev server through a tunnel (so deploy webhooks and Blob
// Storage CORS see a real origin) makes the request's Origin differ from the
// forwarded Host, which Next treats as CSRF and aborts — silently, from the
// caller's point of view. Set DEV_TUNNEL_HOST to the tunnel's host to allow
// it. Unset everywhere else, so no origin is exempted in production.
const devTunnelHost = process.env.DEV_TUNNEL_HOST;

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: devTunnelHost ? [devTunnelHost] : [],
    },
  },
};

export default nextConfig;
