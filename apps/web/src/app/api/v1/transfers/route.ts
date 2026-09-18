// LEARN (Next.js): los Route Handlers son el "backend" dentro de Next.
// Cada archivo route.ts exporta GET/POST. Prisma TX garantiza: débito+crédito+outbox o nada.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCorrelationId, errorBody } from "@/lib/http";
import { createHash, randomUUID } from "crypto";

export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  const idemKey = req.headers.get("Idempotency-Key");
  if (!idemKey) return NextResponse.json(errorBody(422, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key obligatorio", correlationId), { status: 422 });

  const body = await req.json().catch(() => null);
  const { source_account_id, dest_alias, amount, currency = "ARS", memo } = body ?? {};
  if (!source_account_id || !dest_alias || !amount) {
    return NextResponse.json(errorBody(400, "VALIDATION_ERROR", "source_account_id, dest_alias y amount son obligatorios", correlationId), { status: 400 });
  }
  if (Number(amount) <= 0) return NextResponse.json(errorBody(422, "VALIDATION_ERROR", "amount debe ser > 0 (string decimal)", correlationId), { status: 422 });

  const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");

  // 1) Idempotencia: intento insertar; si ya existe COMPLETED -> replay sin debitar.
  try {
    await prisma.idempotencyKey.create({ data: { key: idemKey, accountId: source_account_id, requestHash, status: "IN_PROGRESS", expiresAt: new Date(Date.now() + 24 * 3600 * 1000) } });
  } catch {
    const existing = await prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
    if (existing?.status === "COMPLETED" && existing.responseBody) {
      const res = NextResponse.json(existing.responseBody);
      res.headers.set("Idempotent-Replayed", "true");
      return res;
    }
    return NextResponse.json(errorBody(409, "IDEMPOTENT_IN_FLIGHT", "Reintento en curso, reusa la misma key", correlationId), { status: 409 });
  }

  // 2) TX financiera (OCC simplificado didáctico: leer version, update con where version).
  try {
    const result = await prisma.$transaction(async (tx) => {
      const src = await tx.account.findUnique({ where: { id: source_account_id } });
      const dst = await tx.account.findUnique({ where: { alias: dest_alias } });
      if (!src) throw Object.assign(new Error("origen no existe"), { code: "ACCOUNT_NOT_FOUND" });
      if (!dst) throw Object.assign(new Error("destino no existe"), { code: "DEST_NOT_FOUND" });
      if (src.id === dst.id) throw Object.assign(new Error("origen=destino"), { code: "VALIDATION_ERROR" });
      if (src.status !== "ACTIVE") throw Object.assign(new Error("cuenta congelada"), { code: "ACCOUNT_FROZEN" });
      // Montos como centavos enteros para evitar float.
      const toCents = (s: string) => Math.round(Number(s) * 100);
      const fromCents = (c: number) => (c / 100).toFixed(2);
      const m = toCents(String(amount));
      const srcBal = toCents(src.balance);
      if (srcBal < m) throw Object.assign(new Error("sin fondos"), { code: "INSUFFICIENT_FUNDS" });

      const newSrc = srcBal - m;
      const newDst = toCents(dst.balance) + m;
      // OCC: solo actualiza si version no cambió desde la lectura.
      const updSrc = await tx.account.updateMany({ where: { id: src.id, version: src.version }, data: { balance: fromCents(newSrc), version: src.version + 1 } });
      if (updSrc.count === 0) throw Object.assign(new Error("conflicto concurrente"), { code: "CONCURRENT_MODIFICATION" });
      await tx.account.update({ where: { id: dst.id }, data: { balance: fromCents(newDst), version: { increment: 1 } } });

      const transferId = randomUUID();
      await tx.transfer.create({ data: { id: transferId, sourceAccount: src.id, destAccount: dst.id, amount: Number(amount).toFixed(2), currency, idempotencyKey: idemKey, correlationId } });
      await tx.ledgerEntry.createMany({ data: [
        { transferId, accountId: src.id, direction: "DEBIT", amount: Number(amount).toFixed(2), balanceAfter: fromCents(newSrc) },
        { transferId, accountId: dst.id, direction: "CREDIT", amount: Number(amount).toFixed(2), balanceAfter: fromCents(newDst) },
      ]});
      // 3) OUTBOX en la misma TX (clave de todo el patrón).
      // LEARN: el evento lleva balance_after de AMBOS lados para que los
      // projectors actualicen Redis/Mongo sin volver a PG ( CQRS puro ).
      const payload = { event_id: randomUUID(), event_type: "transfer.completed.v1", transfer_id: transferId, amount: Number(amount).toFixed(2), currency, memo: memo ?? null, source: { account_id: src.id, balance_after: fromCents(newSrc) }, destination: { account_id: dst.id, alias: dst.alias, balance_after: fromCents(newDst) }, correlation_id: correlationId, idempotency_key: idemKey, occurred_at: new Date().toISOString() };
      await tx.outbox.create({ data: { eventId: (payload as any).event_id, aggregate: "transfer", aggregateId: transferId, topic: "transfer.completed.v1", payload: payload as any, headers: { correlation_id: correlationId } } });
      return { transferId, srcBalAfter: fromCents(newSrc) };
    });

    const ok = { transfer_id: result.transferId, status: "COMPLETED", amount: Number(amount).toFixed(2), source_balance_after: result.srcBalAfter, created_at: new Date().toISOString() };
    await prisma.idempotencyKey.update({ where: { key: idemKey }, data: { status: "COMPLETED", responseCode: 201, responseBody: ok as any } });
    return NextResponse.json(ok, { status: 201 });
  } catch (e: any) {
    const code = e.code ?? "INTERNAL";
    const map: Record<string, number> = { INSUFFICIENT_FUNDS: 422, ACCOUNT_FROZEN: 422, CONCURRENT_MODIFICATION: 409, ACCOUNT_NOT_FOUND: 404, DEST_NOT_FOUND: 404, VALIDATION_ERROR: 400 };
    const status = map[code] ?? 500;
    await prisma.idempotencyKey.update({ where: { key: idemKey }, data: { status: "FAILED" } }).catch(() => {});
    return NextResponse.json(errorBody(status, code, e.message, correlationId), { status });
  }
}
