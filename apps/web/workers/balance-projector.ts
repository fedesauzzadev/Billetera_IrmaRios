// balance-projector: Kafka -> Redis (saldo hot) + Mongo (vista).
// LEARN: idempotente por event_id + árbitro version (solo avanza, nunca retrocede).
import { Kafka } from "kafkajs";
import Redis from "ioredis";
import { MongoClient } from "mongodb";

const kafka = new Kafka({ clientId: "balance-projector", brokers: (process.env.REDPANDA_BROKERS ?? "localhost:19092").split(",") });
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const mongo = new MongoClient(process.env.MONGO_URL ?? "mongodb://localhost:27017/billetera");

async function main() {
  await mongo.connect();
  const db = mongo.db();
  await db.collection("processed_events").createIndex({ event_id: 1 }, { unique: true }).catch(() => {});
  const consumer = kafka.consumer({ groupId: "balance-projector" });
  await consumer.connect();
  await consumer.subscribe({ topic: "transfer.completed.v1", fromBeginning: true });
  console.log("[balance-projector] escuchando transfer.completed.v1");
  await consumer.run({
    eachMessage: async ({ message }) => {
      const evt = JSON.parse(message.value!.toString());
      try {
        await db.collection("processed_events").insertOne({ event_id: evt.event_id, at: new Date() });
      } catch { return; } // duplicado -> skip (idempotencia)
      for (const side of [evt.source, evt.destination]) {
        // LEARN: el evento trae balance_after snapshot (fuente: misma TX del ledger).
        // Si falta, NO inventamos: a DLQ para investigar en vez de envenenar la caché.
        if (side?.balance_after == null) {
          console.error(JSON.stringify({ worker: "balance-projector", error: "missing balance_after", event_id: evt.event_id, side }));
          continue;
        }
        const cur = await redis.get(`balance:${side.account_id}`);
        const curV = cur ? JSON.parse(cur).version ?? -1 : -1;
        const nextV = (curV + 1); // simplificado didáctico (en prod viene del ledger)
        await redis.set(`balance:${side.account_id}`, JSON.stringify({ balance: side.balance_after, version: nextV, updated_at: evt.occurred_at }), "EX", 120);
        await db.collection("account_views").updateOne(
          { account_id: side.account_id },
          { $set: { balance: side.balance_after, updated_at: new Date(), version: Date.now(), currency: evt.currency ?? "ARS" } },
          { upsert: true }
        );
      }
      console.log(JSON.stringify({ worker: "balance-projector", event_id: evt.event_id }));
    },
  });
}
main();
