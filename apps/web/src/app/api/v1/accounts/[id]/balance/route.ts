import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { mongoDb } from "@/lib/mongo";
import { getCorrelationId } from "@/lib/http";

// LEARN: lectura NUNCA toca PostgreSQL. Redis (ms) -> Mongo (vista) -> stale.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  try { await redis().connect().catch(() => {}); } catch {}
  try {
    const hit = await redis().get(`balance:${id}`);
    if (hit) {
      const v = JSON.parse(hit);
      // LEARN (defensa): si el caché no trae balance (vista parcial), se trata
      // como MISS en vez de devolver saldo vacío. Nunca envenenar al cliente.
      if (v?.balance != null) {
        const res = NextResponse.json({ account_id: id, balance: v.balance, currency: "ARS", updated_at: v.updated_at });
        res.headers.set("X-Cache", "HIT");
        return res;
      }
    }
  } catch {}
  try {
    const db = await mongoDb();
    const view = await db.collection("account_views").findOne({ account_id: id });
    if (view?.balance != null) {
      try { await redis().set(`balance:${id}`, JSON.stringify({ balance: view.balance, version: view.version, updated_at: view.updated_at }), "EX", 120); } catch {}
      const res = NextResponse.json({ account_id: id, balance: view.balance, currency: "ARS", updated_at: view.updated_at });
      res.headers.set("X-Cache", "MISS");
      return res;
    }
  } catch {
    // Mongo caído -> degradación elegante: último Redis aunque esté vencido (stale).
    try {
      const stale = await redis().get(`balance:${id}`);
      if (stale) {
        const v = JSON.parse(stale);
        if (v?.balance == null) throw new Error("stale sin balance");
        const res = NextResponse.json({ account_id: id, balance: v.balance, currency: "ARS", updated_at: v.updated_at, stale: true });
        res.headers.set("X-Stale", "true");
        return res;
      }
    } catch {}
    const res = NextResponse.json({ code: "READ_MODEL_UNAVAILABLE", detail: "Historial/saldo temporalmente no disponible", correlation_id: getCorrelationId(_req) }, { status: 503 });
    return res;
  }
  return NextResponse.json({ code: "ACCOUNT_NOT_FOUND", detail: "Sin proyección aún (¿transferencia pendiente?)", correlation_id: getCorrelationId(_req) }, { status: 404 });
}
