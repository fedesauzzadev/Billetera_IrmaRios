import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
// Health para Docker + V0: verifica PG; workers/brokers se ven en /api/health/detallado (fase 2).
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", ledger: "up", ts: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ status: "degraded", ledger: "down", detail: e.message }, { status: 503 });
  }
}
