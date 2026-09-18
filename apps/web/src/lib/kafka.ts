import { Kafka } from "kafkajs";
// Redpanda habla API Kafka: kafkajs funciona sin cambios. Brokers: localhost:19092 (local) o redpanda:29092 (docker).
export function kafka() {
  return new Kafka({ clientId: "billetera-web", brokers: (process.env.REDPANDA_BROKERS ?? "localhost:19092").split(",") });
}
export const TOPICS = { transferCompleted: "transfer.completed.v1", dlq: "transfer.completed.dlq.v1" } as const;
