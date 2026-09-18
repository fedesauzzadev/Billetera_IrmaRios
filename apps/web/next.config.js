/** @type {import('next').NextConfig} */
const nextConfig = {
  // CORS abierto en dev para que V0 (otro origen) consuma el backend sin fricción.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, Idempotency-Key, X-Correlation-Id" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
