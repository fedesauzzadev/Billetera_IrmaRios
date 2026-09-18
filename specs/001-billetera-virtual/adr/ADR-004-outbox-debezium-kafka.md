# ADR-004: Outbox + Debezium + Kafka (sin dual-write)

**Estado:** Aceptado | **Fecha:** 2026-09-18

## Contexto
Publicar a Kafka desde la app tras commitear PG pierde eventos si el proceso muere entremedio. Publicar antes de commitear crea eventos fantasma.

## Decisión
Tabla `outbox` escrita en la misma TX del ledger. Debezium (CDC) la lee y publica a Kafka. Relay marca `dispatched_at`. Consumidores idempotentes por `event_id`.

## Consecuencias
- (+) Exactly-once efectiva: sin pérdida ni duplicado visible.
- (+) Relay desacoplado; replay natural desde Kafka.
- (−) Latencia extra 100-300ms en proyección; operar Connect/Debezium.
- Regla dura: prohibido `db.Commit(); kafka.Publish()` directo en código de negocio.
