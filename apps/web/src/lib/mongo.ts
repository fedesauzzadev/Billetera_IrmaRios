import { MongoClient } from "mongodb";
const g = globalThis as unknown as { __mongo?: MongoClient };
export async function mongoDb() {
  if (!g.__mongo) {
    g.__mongo = new MongoClient(process.env.MONGO_URL ?? "mongodb://localhost:27017/billetera");
    await g.__mongo.connect();
  }
  return g.__mongo.db();
}
