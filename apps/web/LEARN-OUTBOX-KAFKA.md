# Guía didáctica: Outbox + Kafka (Redpanda) en este proyecto

> Lee esto antes de tocar `workers/`. Todo gratuito y dockerizado.

## 1. El problema (dual-write) con ejemplo
Queremos: guardar transferencia en PG **y** avisar a Redis/Mongo vía Kafka.
Ingenuo (MAL):
```ts
await db.transfer.create(...); // commit PG
await kafka.send(...);         // ¿y si acá se cae el proceso? PG tiene la plata, Kafka nunca se enteró -> saldo viejo para siempre.
```
Al revés también falla (evento fantasma sin commit). Esto se llama **dual-write** y está prohibido en `spec.md RF-04`.

## 2. La solución: tabla Outbox (misma TX)
```ts
await prisma.$transaction(async (tx) => {
  await tx.account.update(...);      // débito
  await tx.account.update(...);      // crédito
  await tx.ledgerEntry.createMany(...);
  await tx.outbox.create({ data: {...} }); // <-- mismo commit
});
```
O todo commitea junto, o nada. El evento **nace durable** en PG.

## 3. El Relay: de PG a Redpanda
`workers/outbox-relay.ts` cada 500ms:
1. `SELECT ... WHERE dispatched_at IS NULL ... FOR UPDATE SKIP LOCKED LIMIT 100`
   - `SKIP LOCKED` = dos relays no se pisan (puedes escalar a 3 sin miedo).
2. `producer.send({ topic, key: account_id, value: payload })`
   - `key=account_id` = **orden garantizado por cuenta** (tus transferencias salen en orden), paralelismo entre cuentas.
   - Redpanda = Kafka sin Zookeeper, 1 contenedor, UI en `http://localhost:8080`.
3. `UPDATE outbox SET dispatched_at=now()` solo si publish OK.
   - Si Redpanda está caído (`docker stop redpanda`), no marca -> reintenta solo. **Cero pérdida.** Pruébalo.

## 4. Conexión Next.js ↔ Redpanda (kafkajs)
- `src/lib/kafka.ts`: `new Kafka({ brokers: ["redpanda:29092"] })` en Docker, `localhost:19092` fuera.
- Producer (relay) con `allowAutoTopicCreation: true` (didáctico; en prod crear tópicos con `rpk`).
- Consumers (`balance/history-projector`) con `groupId` distinto: **cada grupo recibe copia** del evento (uno actualiza Redis, otro Mongo).
- Headers Kafka: `correlation_id` + `event_id` (trace de punta a punta).

## 5. Idempotencia del consumidor (el otro 50% del truco)
Kafka puede entregar 2 veces. Por eso:
- `processed_events(event_id unique)` + `insert` primero: si ya existe -> skip.
- Redis: solo actualiza si `version` nueva es mayor (árbitro).
- Mongo `movements._id = transfer_id:lado` + índice unique en `event_id`.
- Prueba: mata y reinicia un projector, verás replays sin duplicar saldo.

## 6. Experimentos para aprender (orden sugerido)
1. `docker compose up` -> `http://localhost:8080` (Redpanda Console) -> ver tópico `transfer.completed.v1` vacío.
2. `npm run seed` -> anota los IDs.
3. POST `/api/v1/transfers` con `Idempotency-Key` -> ve el evento en Console + `SELECT * FROM outbox` con `dispatched_at` lleno.
4. Repite POST con **misma key** -> `Idempotent-Replayed: true`, sin fila nueva en `ledger_entries`.
5. `docker stop redpanda` -> POST -> `outbox.dispatched_at` queda NULL -> `docker start redpanda` -> se publica solo.
6. `docker stop mongo` -> GET saldo sigue con `X-Stale: true` (degradación).
7. Doble POST concurrente misma cuenta sin fondos -> uno 201, otro 422 (OCC + CHECK).

## 7. ¿Y Debezium? (fase 2, no MVP)
Debezium lee el WAL de PG (CDC) sin polling. Ventajas: menos carga PG, latencia menor. Costo: JVM + Kafka Connect (pesado para laptop). Nuestro relay polling es **intencionalmente simple para aprender**; el contrato (tabla outbox + tópico + key) es idéntico, así que migrar es cambiar el relay, no el negocio. Ver `ADR-004`.
