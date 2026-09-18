# Observabilidad y Runbooks — el "broche de oro"

Sin esto, un sistema financiero distribuido es una caja negra. Todo lo de aquí es P0.

## 1. Correlación distribuida (obligatoria)

- Gateway genera `X-Correlation-Id` (UUIDv7) si el cliente no lo envía. Se propaga en:
  - Headers HTTP (`X-Correlation-Id`), consultas a PG (`SET app.correlation_id`), headers Kafka (`correlation_id`), logs y eventos.
- En .NET: `ActivitySource` + OpenTelemetry → Jaeger/Tempo. Nombres: `POST /v1/transfers`, `db.postgres.tx`, `kafka.publish transfer.completed`, `projector.apply`.
- Regla: ningún log sin `correlation_id + account_id + transfer_id/event_id`.

Ejemplo log JSON:

```json { "ts": "2026-09-18T12:00:01Z", "lvl": "info", "svc": "transaction-service", "correlation_id": "uuid", "transfer_id": "uuid", "account_id": "uuid", "msg": "ledger committed", "elapsed_ms": 42, "version_src": 419 }
```

## 2. Métricas (Prometheus + Grafana)

### Negocio (las que mira el CEO)

- `wallet_transfer_completed_total{currency}` + `wallet_transfer_amount_sum` (volumen).
- `wallet_topup_completed_total`, `wallet_fraud_rejected_total`.
- `wallet_stale_balance_served_total` (degradación visible).

### Técnicas (las que mira SRE)

- Latencia: `http_server_duration_seconds{route="/v1/transfers"}` p50/p95/p99.
- `db_tx_duration_seconds`, `kafka_consumer_lag{group,topic}`, `outbox_oldest_undispatched_seconds`.
- `redis_hit_ratio{key="balance:*"}`, `mongo_query_duration_seconds`.
- Breakers: `circuit_breaker_state{target="fraud|mongo|redis"}`.
- Idempotencia: `idempotent_replayed_total`, `idempotency_reuse_total`.

Dashboards: `Golden Signals` (latencia, tráfico, errores, saturación) + `Ledger Health` (lag, outbox, OCC conflicts `occ_conflict_total`).

## 3. Alertas (Alertmanager)

| Alerta | Condición | Severidad | Acción |
|---|---|---|---|
| Escritura lenta | p95 `/transfers` >1s 5m | P1 | Escalar TX, revisar PG locks |
| Lag crítico | lag >5000 5m | P1 | Escalar projectors, pausar deploys |
| Outbox atascado | `outbox_oldest` >30s | P1 | Revisar Debezium/Connect |
| Redis frío | hit-ratio <70% 15m | P2 | Pre-warm, revisar TTL/invalidación |
| 5xx alto | >1% 5m | P1 | Rollback canary |
| Fraude caído | CB open >5m | P2 | Ver runbook fraude |
| Saldo stale alto | `stale_served` >5% tráfico | P2 | Revisar Mongo |

## 4. Runbooks

### R1 — Lag Kafka crece
1. `kubectl scale deploy/history-projector --replicas=+5` (o deja a KEDA).
2. Verificar `kafka_consumer_lag` por partición: si una partición concentra todo → hot account, revisar key.
3. Si DLQ crece → pausar projector, inspeccionar `*.dlq`, fix, replay con tool `kafka-replay --from-dlq`.
4. Si Mongo lento → `db.currentOp()`, índices, escalar.

### R2 — Doble cobro reportado
1. Pedir `Idempotency-Key` + `correlation_id` al cliente.
2. `SELECT * FROM idempotency_keys WHERE key=:k` + `SELECT * FROM ledger_entries WHERE transfer_id=:t`.
3. Si 2 transfers con distinta key pero mismo negocio → es reintento con key nueva (bug del cliente). Compensar con reversa (nunca DELETE).
4. Emitir `transfer.reversed.v1` y acreditar.

### R3 — Mongo caído
1. Confirmar que Redis sirve stale (`X-Stale: true` + métrica).
2. Activar flag `history.readonly_banner=true`.
3. Recuperar Mongo desde snapshot + replay Kafka desde último offset confirmado (los projectors hacen catch-up solo).
4. Validar convergencia: `balance PG vs Redis vs Mongo` con job `reconcile --sample 1000`.

### R4 — PostgreSQL primario caído
1. Failover automático Patroni → promover réplica sync (RPO=0).
2. TX reintentan con backoff; Gateway devuelve 503 + `Retry-After: 5` durante 30s.
3. Verificar `ledger` sin huecos: `SELECT COUNT(*) vs MAX(entry_id)`.

## 5. Trazabilidad de negocio (auditoría)

- Job nocturno `reconcile`: `SUM(ledger por cuenta) == accounts.balance` (muestra 100% en MVP, luego muestreo + completo semanal).
- Trail inmutable: todo cambio de saldo tiene `transfer_id + event_id + correlation_id`. Soporte puede responder "¿dónde está mi plata?" en <2 min con un trace.
