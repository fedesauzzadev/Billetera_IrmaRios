import { NextRequest, NextResponse } from "next/server";
// Hace de "API Gateway gratuito": auth mock + rate-limit simple + correlation-id.
// Didáctico: en prod usar Upstash Ratelimit / Kong, acá basta memoria.
const hits = new Map<string, { n: number; reset: number }>();
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const corr = req.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  res.headers.set("X-Correlation-Id", corr);
  if (req.nextUrl.pathname.startsWith("/api/v1/") && req.method === "POST") {
    const ip = req.headers.get("x-forwarded-for") ?? "local";
    const now = Date.now();
    const w = hits.get(ip) ?? { n: 0, reset: now + 60_000 };
    if (now > w.reset) { w.n = 0; w.reset = now + 60_000; }
    w.n++;
    hits.set(ip, w);
    if (w.n > 60) return NextResponse.json({ code: "RATE_LIMITED", detail: "Máximo 60 escrituras/min en demo local" }, { status: 429 });
  }
  return res;
}
export const config = { matcher: ["/api/:path*"] };
