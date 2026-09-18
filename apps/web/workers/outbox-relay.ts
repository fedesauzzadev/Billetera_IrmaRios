// ============================================================
// LEARN: OUTBOX RELAY didáctico (el archivo más importante).
// Problema que resuelve: NO se puede hacer db.commit() + kafka.publish()
//   en secuencia (dual-write) porque si el proceso muere entremedio
//   pierdes el evento o creas un fantasma. Solución: tabla outbox
//   escrita EN LA MISMA TX que el ledger. Este worker la lee y publica.
// Flujo: poll cada 500ms -> SELECT ... FOR UPDATE SKIP LOCKED (sin pelear
//   entre réplicas) -> publish a Redpanda (key=account_id = orden por cuenta)
//   -> UPDATE dispatched_at. Si Redpanda está caído, NO marca y reintenta.
// Ver: LEARN-OUTBOX-KAFKA.md
// ============================================================
import { PrismaClient } from "@prisma/client";
import { Kafka } from "kafkajs";

const prisma = new PrismaClient();
const kafka = new Kafka({ clientId: "outbox-relay", brokers: (process.env.REDPANDA_BROKERS ?? "localhost:19092").split(",") });
const producer = kafka.producer({ allowAutoTopicCreation: true });

async function tick() {
  // SKIP LOCKED = dos relays pueden correr sin pisarse (didáctico + seguro).
  const batch: any[] = await prisma.$queryRaw`
    SELECT event_id, topic, payload, headers FROM outbox
    WHERE dispatched_at IS NULL ORDER BY created_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED`;
  if (!batch.length) return;
  for (const e of batch) {
    const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
    const key = payload?.source?.account_id ?? payload?.account_id ?? e.event_id;
    await producer.send({
      topic: e.topic,
      messages: [{ key, value: JSON.stringify(payload), headers: { correlation_id: String((e.headers as any)?.correlation_id ?? ""), event_id: String(e.event_id) } }],
    });
    await prisma.outbox.update({ where: { eventId: e.event_id }, data: { dispatchedAt: new Date() } });
    console.log(JSON.stringify({ worker: "outbox-relay", event_id: e.event_id, topic: e.topic, key }));
  }
}

async function main() {
  await producer.connect();
  console.log("[outbox-relay] conectado a", process.env.REDPANDA_BROKERS);
  for (;;) {
    try { await tick(); }
    catch (err) { console.error("[outbox-relay] tick error (reintenta en 500ms):", (err as Error).message); }
    await new Promise((r) => setTimeout(r, 500));
  }
}
main();
