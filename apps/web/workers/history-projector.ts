// history-projector: Kafka -> Mongo movements (desnormalizado, listo para V0).
import { Kafka } from "kafkajs";
import { MongoClient } from "mongodb";

const kafka = new Kafka({ clientId: "history-projector", brokers: (process.env.REDPANDA_BROKERS ?? "localhost:19092").split(",") });
const mongo = new MongoClient(process.env.MONGO_URL ?? "mongodb://localhost:27017/billetera");

async function main() {
  await mongo.connect();
  const db = mongo.db();
  await db.collection("movements").createIndex({ account_id: 1, created_at: -1 }).catch(() => {});
  await db.collection("movements").createIndex({ event_id: 1 }, { unique: true }).catch(() => {});
  const consumer = kafka.consumer({ groupId: "history-projector" });
  await consumer.connect();
  await consumer.subscribe({ topic: "transfer.completed.v1", fromBeginning: true });
  console.log("[history-projector] escuchando transfer.completed.v1");
  await consumer.run({
    eachMessage: async ({ message }) => {
      const evt = JSON.parse(message.value!.toString());
      const docs = [
        { _id: `${evt.transfer_id}:out`, account_id: evt.source.account_id, transfer_id: evt.transfer_id, type: "P2P_OUT", amount: `-${evt.amount}`, counterparty: evt.destination.alias ?? "destino", event_id: evt.event_id + ":out", created_at: new Date(evt.occurred_at) },
        { _id: `${evt.transfer_id}:in`, account_id: evt.destination.account_id, transfer_id: evt.transfer_id, type: "P2P_IN", amount: `${evt.amount}`, counterparty: "origen", event_id: evt.event_id + ":in", created_at: new Date(evt.occurred_at) },
      ];
      for (const d of docs) {
        try { await db.collection("movements").insertOne(d); }
        catch { /* duplicado -> idempotente */ }
      }
      // Recientes embebidos para primera pantalla V0.
      // LEARN: upsert:false a propósito. Este projector NUNCA crea la vista
      // (no conoce saldos); solo enriquece la que crea balance-projector.
      // Crear docs sin balance envenenaba la caché con `{}` (bug real que encontramos).
      await db.collection("account_views").updateOne(
        { account_id: evt.source.account_id },
        { $push: { recent: { $each: [{ transfer_id: evt.transfer_id, type: "P2P_OUT", amount: `-${evt.amount}`, created_at: evt.occurred_at }], $slice: 20 } } },
        { upsert: false }
      );
      console.log(JSON.stringify({ worker: "history-projector", event_id: evt.event_id }));
    },
  });
}
main();
