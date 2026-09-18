import Redis from "ioredis";
const g = globalThis as unknown as { __redis?: Redis };
export function redis() {
  if (!g.__redis) g.__redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 2 });
  return g.__redis;
}
